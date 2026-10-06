// Native shell for legit: one window, backed by a `legit-server` sidecar (the Node engine
// compiled into a standalone binary) for the repository it shows. Opening another repository
// starts a server for it, points the window at it, and stops the old one.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

struct Server {
    repo: PathBuf,
    child: Child,
    /// The page's origin, "http://127.0.0.1:<port>".
    origin: String,
}

/// The server of the window's repository.
#[derive(Default)]
struct Current(Mutex<Option<Server>>);

impl Current {
    fn repo(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().as_ref().map(|s| s.repo.clone())
    }
}

/// What each repository's page last asked to keep (selection, drafts, scroll), so coming back to
/// it finds things as they were, by repository; and every server's origin, to know a page's
/// repository even once it's been switched away from. Memory only.
#[derive(Default)]
struct Views {
    kept: Mutex<HashMap<PathBuf, String>>,
    origins: Mutex<HashMap<String, PathBuf>>,
}

/// The one window's label (capabilities/default.json grants it the app's commands).
const WINDOW: &str = "repo";

/// How long a server gets to finish an in-flight operation before it's killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // `legit <path>` or a second launch: open the repo in this instance's window.
            match repo_arg(&argv, Path::new(&cwd)) {
                Some(path) => open_repo(app, path),
                None => focus_any(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Current::default())
        .manage(Recent::default())
        .manage(Views::default())
        .menu(build_menu)
        .invoke_handler(tauri::generate_handler![
            commands::recent_repos,
            commands::open_repo,
            commands::pick_repo,
            commands::forget_repo,
            commands::remember_view,
            commands::recall_view
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => pick_repo(app, false),
            "recent-clear" => update_recent(app, |list| list.clear()),
            id if id.starts_with("recent:") => open_repo(app, PathBuf::from(&id["recent:".len()..])),
            "undo" => eval_focused(app, "window.__legit?.undo()"),
            "redo" => eval_focused(app, "window.__legit?.redo()"),
            "reload" => eval_focused(app, "location.reload()"),
            "branch" => eval_focused(app, "window.__legit?.branch()"),
            "merge" => eval_focused(app, "window.__legit?.branch('merge')"),
            "rebase" => eval_focused(app, "window.__legit?.branch('rebase')"),
            "rebase-base" => eval_focused(app, "window.__legit?.rebaseOnBase()"),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let server = window.state::<Current>().0.lock().unwrap().take();
                if let Some(server) = server {
                    thread::spawn(move || stop(server));
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().collect();
            match repo_arg(&args, &cwd).or_else(|| recent(&handle).into_iter().next()) {
                Some(path) => open_repo(&handle, path),
                None => pick_repo(&handle, true),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start legit")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(server) = app.state::<Current>().0.lock().unwrap().take() {
                    stop(server);
                }
            }
        });
}

/// First non-flag argument after the program name, resolved against `cwd`.
fn repo_arg(argv: &[String], cwd: &Path) -> Option<PathBuf> {
    argv.iter().skip(1).find(|a| !a.starts_with('-')).map(|a| cwd.join(a))
}

/// Recently opened repositories, most recent first: one path per line in the config dir.
#[derive(Default)]
struct Recent(Mutex<()>);

const RECENT_MAX: usize = 30;

fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

/// The recent repositories that still exist (older versions only kept `last-repo`).
fn recent(app: &AppHandle) -> Vec<PathBuf> {
    let read = |name| config_file(app, name).and_then(|f| std::fs::read_to_string(f).ok());
    let text = read("recent-repos").or_else(|| read("last-repo")).unwrap_or_default();
    let mut list: Vec<PathBuf> = Vec::new();
    for path in text.lines().filter(|l| !l.trim().is_empty()).map(PathBuf::from) {
        if path.is_dir() && !list.contains(&path) {
            list.push(path);
        }
    }
    list
}

/// Change the recent list, save it, and rebuild the Open Recent menu.
fn update_recent(app: &AppHandle, change: impl FnOnce(&mut Vec<PathBuf>)) {
    {
        let state = app.state::<Recent>();
        let _lock = state.0.lock().unwrap();
        let mut list = recent(app);
        change(&mut list);
        let mut seen = Vec::new();
        list.retain(|p| !seen.contains(p) && {
            seen.push(p.clone());
            true
        });
        list.truncate(RECENT_MAX);
        if let Some(file) = config_file(app, "recent-repos") {
            let text: Vec<&str> = list.iter().filter_map(|p| p.to_str()).collect();
            let _ = std::fs::create_dir_all(file.parent().unwrap());
            let _ = std::fs::write(file, text.join("\n"));
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(menu) = build_menu(&handle) {
            let _ = handle.set_menu(menu);
        }
    });
}

/// A folder git would treat as a repository's root (a `.git` dir, or a `.git` file for worktrees).
fn is_repo(path: &Path) -> bool {
    path.is_dir() && path.join(".git").exists()
}

/// "~/code/legit" for a path under the home directory.
fn short_path(app: &AppHandle, path: &Path) -> String {
    match app.path().home_dir().ok().and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

fn repo_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// What the window's page may call (see capabilities/default.json): the recent list, and
/// opening only what's already in it, or what the user picks in the native dialog.
mod commands {
    use super::*;

    #[derive(serde::Serialize)]
    pub struct RecentRepo {
        path: String,
        name: String,
        /// Shortened for display: "~/code/legit".
        short: String,
        /// Shown now.
        current: bool,
    }

    #[tauri::command]
    pub fn recent_repos(app: AppHandle) -> Vec<RecentRepo> {
        let current = app.state::<Current>().repo();
        recent(&app)
            .into_iter()
            .filter_map(|p| {
                Some(RecentRepo {
                    path: p.to_str()?.to_string(),
                    name: repo_name(&p),
                    short: short_path(&app, &p),
                    current: current.as_ref() == Some(&p),
                })
            })
            .collect()
    }

    /// Open a repository from the recent list, nothing else.
    #[tauri::command]
    pub fn open_repo(app: AppHandle, path: String) -> Result<(), String> {
        let path = PathBuf::from(path);
        if !recent(&app).contains(&path) {
            return Err("That repository isn't in the recent list.".into());
        }
        if !is_repo(&path) {
            return Err(format!("{} isn't a git repository anymore.", path.display()));
        }
        super::open_repo(&app, path);
        Ok(())
    }

    #[tauri::command]
    pub fn pick_repo(app: AppHandle) {
        super::pick_repo(&app, false);
    }

    #[tauri::command]
    pub fn forget_repo(app: AppHandle, path: String) {
        update_recent(&app, |list| list.retain(|p| p != Path::new(&path)));
    }

    /// Keep a page's view of its repository. By origin, so a page still unloading after the window
    /// switched files it under its own repository, not the new one.
    #[tauri::command]
    pub fn remember_view(app: AppHandle, origin: String, state: String) {
        let views = app.state::<Views>();
        let repo = views.origins.lock().unwrap().get(&origin).cloned();
        if let Some(repo) = repo.filter(|_| state.len() <= 1 << 20) {
            views.kept.lock().unwrap().insert(repo, state);
        }
    }

    /// What was kept for the page's repository, once.
    #[tauri::command]
    pub fn recall_view(app: AppHandle, origin: String) -> Option<String> {
        let views = app.state::<Views>();
        let repo = views.origins.lock().unwrap().get(&origin).cloned()?;
        let kept = views.kept.lock().unwrap().remove(&repo);
        kept
    }
}

fn pick_repo(app: &AppHandle, quit_if_cancelled: bool) {
    let handle = app.clone();
    app.dialog().file().set_title("Open a git repository").pick_folder(move |folder| {
        match folder.and_then(|f| f.into_path().ok()) {
            Some(path) => open_repo(&handle, path),
            None if quit_if_cancelled && handle.webview_windows().is_empty() => handle.exit(0),
            None => {}
        }
    });
}

fn focus_any(app: &AppHandle) {
    match app.webview_windows().values().next() {
        Some(w) => {
            let _ = w.set_focus();
        }
        None => pick_repo(app, true),
    }
}

/// Show `path` in the window: start a server for it, then open the window on it, or switch the
/// window to it (the page saves what it shows first, to find it again when it comes back).
fn open_repo(app: &AppHandle, path: PathBuf) {
    let path = path.canonicalize().unwrap_or(path);
    let window = app.get_webview_window(WINDOW);
    if let Some(window) = &window {
        let _ = window.unminimize();
        let _ = window.set_focus();
        if app.state::<Current>().repo().as_ref() == Some(&path) {
            return;
        }
        let _ = window.eval("window.__legit?.remember()");
    }

    let app = app.clone();
    thread::spawn(move || {
        if let Err(err) = start(&app, &path) {
            eprintln!("legit: couldn't open {}: {err}", path.display());
            app.dialog()
                .message(err)
                .title("Couldn't open repository")
                .kind(MessageDialogKind::Error)
                .show(move |_| {});
            if app.webview_windows().is_empty() {
                pick_repo(&app, true);
            }
        }
    });
}

/// Start a server for `repo`; returns it and the URL it serves the UI on.
fn spawn_server(app: &AppHandle, repo: &Path) -> Result<(Child, Url), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sidecar = exe.with_file_name("legit-server");
    let dist = app.path().resource_dir().map_err(|e| e.to_string())?.join("dist");
    // Apps launched from Finder get a minimal PATH; find git where a terminal would.
    let path_env = format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default());

    let mut child = Command::new(&sidecar)
        .arg(repo)
        .arg("--dist")
        .arg(&dist)
        .env("PATH", path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", sidecar.display()))?;

    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut url = String::new();
    stdout.read_line(&mut url).map_err(|e| e.to_string())?;
    let url = url.trim().to_string();
    if !url.starts_with("http://") {
        let mut err = String::new();
        let _ = child.stderr.take().unwrap().read_to_string(&mut err);
        let _ = child.wait();
        return Err(if err.trim().is_empty() { "The legit server failed to start.".into() } else { err.trim().into() });
    }
    // Keep draining the server's output so it never blocks on a full pipe.
    let mut stderr = child.stderr.take().unwrap();
    thread::spawn(move || std::io::copy(&mut stdout, &mut std::io::sink()));
    thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::stderr()));
    match Url::parse(&url) {
        Ok(url) => Ok((child, url)),
        Err(e) => {
            stop(Server { repo: repo.to_path_buf(), child, origin: String::new() });
            Err(e.to_string())
        }
    }
}

fn start(app: &AppHandle, repo: &Path) -> Result<(), String> {
    let (child, url) = spawn_server(app, repo)?;
    let server = Server { repo: repo.to_path_buf(), child, origin: url.origin().ascii_serialization() };
    app.state::<Views>().origins.lock().unwrap().insert(server.origin.clone(), repo.to_path_buf());
    let name = repo_name(repo);
    let opened = repo.to_path_buf();
    if let Some(window) = app.get_webview_window(WINDOW) {
        // The page loads afresh from the new server, so nothing of the old repository carries over.
        if let Err(e) = window.navigate(url) {
            stop(server);
            return Err(e.to_string());
        }
        let _ = window.set_title(&name);
        let old = app.state::<Current>().0.lock().unwrap().replace(server);
        if let Some(old) = old {
            thread::spawn(move || stop(old));
        }
        update_recent(app, move |list| list.insert(0, opened));
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title(&name)
        .inner_size(1320.0, 860.0)
        .min_inner_size(760.0, 480.0)
        .disable_drag_drop_handler()
        // The page's header doubles as the title bar, with the traffic lights inset into it.
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 26.0))
        .build();
    if let Err(e) = window {
        stop(server);
        return Err(e.to_string());
    }
    *app.state::<Current>().0.lock().unwrap() = Some(server);
    update_recent(app, move |list| list.insert(0, opened));
    Ok(())
}

/// Close the server's stdin so it exits once any running operation is done; kill it
/// only if it hasn't after a grace period.
fn stop(mut server: Server) {
    drop(server.child.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = server.child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = server.child.kill();
    let _ = server.child.wait();
}

fn eval_focused(app: &AppHandle, js: &str) {
    if let Some(w) = app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)) {
        let _ = w.eval(js);
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Legit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Legit"), None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    // Open Recent: by name, with the folder when two share a name.
    let list = recent(app);
    let open_recent = Submenu::new(app, "Open Recent", true)?;
    for path in list.iter().filter(|p| p.to_str().is_some()) {
        let name = repo_name(path);
        let clash = list.iter().filter(|p| repo_name(p) == name).count() > 1;
        let label = if clash { format!("{name} — {}", short_path(app, path)) } else { name };
        open_recent.append(&MenuItem::with_id(app, format!("recent:{}", path.display()), label, true, None::<&str>)?)?;
    }
    if !list.is_empty() {
        open_recent.append(&sep()?)?;
    }
    open_recent.append(&MenuItem::with_id(app, "recent-clear", "Clear Menu", !list.is_empty(), None::<&str>)?)?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open", "Open Repository…", true, Some("CmdOrCtrl+O"))?,
            &open_recent,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    // Undo/redo go to the page, which undoes text edits in a focused field and history
    // rewrites otherwise. The native items would swallow ⌘Z before the page sees it.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    // The page's own keys (b, m, r) aren't accelerators here: they'd fire while typing in a field.
    let branch = Submenu::with_items(
        app,
        "Branch",
        true,
        &[
            &MenuItem::with_id(app, "branch", "Switch Branch…", true, None::<&str>)?,
            &MenuItem::with_id(app, "merge", "Merge a Branch…", true, None::<&str>)?,
            &MenuItem::with_id(app, "rebase", "Rebase on a Branch…", true, None::<&str>)?,
            &sep()?,
            &MenuItem::with_id(app, "rebase-base", "Rebase on the Default Branch", true, None::<&str>)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, Some("Zoom"))?],
    )?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &branch, &window])
}
