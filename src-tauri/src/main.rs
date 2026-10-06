// Native shell for legit: one window per repository, each backed by its own
// `legit-server` sidecar (the Node engine compiled into a standalone binary). Switching a
// window to another repository starts a server for it and stops the old one.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

struct Server {
    repo: PathBuf,
    child: Child,
    /// The page's origin, "http://127.0.0.1:<port>".
    origin: String,
}

/// Running servers, keyed by window label.
#[derive(Default)]
struct Servers(Mutex<HashMap<String, Server>>);

impl Servers {
    fn repo_at(&self, origin: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().values().find(|s| s.origin == origin).map(|s| s.repo.clone())
    }
}

/// What each repository's page last asked to keep (selection, drafts, scroll), so a window that
/// comes back to it finds things as they were. Memory only.
#[derive(Default)]
struct Views(Mutex<HashMap<PathBuf, String>>);

static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// How long a server gets to finish an in-flight operation before it's killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // `legit <path>` or a second launch: open the repo in this instance.
            match repo_arg(&argv, Path::new(&cwd)) {
                Some(path) => open_repo(app, path, None),
                None => focus_any(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Servers::default())
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
            "open" => pick_repo(app, false, None),
            "recent-clear" => update_recent(app, |list| list.clear()),
            id if id.starts_with("recent:") => open_repo(app, PathBuf::from(&id["recent:".len()..]), None),
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
                let server = window.state::<Servers>().0.lock().unwrap().remove(window.label());
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
                Some(path) => open_repo(&handle, path, None),
                None => pick_repo(&handle, true, None),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start legit")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let servers: Vec<Server> = app.state::<Servers>().0.lock().unwrap().drain().map(|(_, s)| s).collect();
                let stopping: Vec<_> = servers.into_iter().map(|s| thread::spawn(move || stop(s))).collect();
                for t in stopping {
                    let _ = t.join();
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

/// What the repo windows' pages may call (see capabilities/default.json): the recent list, and
/// opening only what's already in it, or what the user picks in the native dialog.
mod commands {
    use super::*;

    #[derive(serde::Serialize)]
    pub struct RecentRepo {
        path: String,
        name: String,
        /// Shortened for display: "~/code/legit".
        short: String,
        /// Shown in the window asking.
        current: bool,
        /// Shown in another window.
        elsewhere: bool,
    }

    #[tauri::command]
    pub fn recent_repos(app: AppHandle, window: tauri::WebviewWindow) -> Vec<RecentRepo> {
        let (current, open) = {
            let servers = app.state::<Servers>();
            let servers = servers.0.lock().unwrap();
            let open: Vec<PathBuf> =
                servers.iter().filter(|(label, _)| *label != window.label()).map(|(_, s)| s.repo.clone()).collect();
            (servers.get(window.label()).map(|s| s.repo.clone()), open)
        };
        recent(&app)
            .into_iter()
            .filter_map(|p| {
                Some(RecentRepo {
                    path: p.to_str()?.to_string(),
                    name: repo_name(&p),
                    short: short_path(&app, &p),
                    current: current.as_ref() == Some(&p),
                    elsewhere: open.contains(&p),
                })
            })
            .collect()
    }

    /// Open a repository from the recent list (nothing else) in the asking window, or in a new one
    /// with `new_window`. A repository open in another window focuses that window instead.
    #[tauri::command]
    pub fn open_repo(app: AppHandle, window: WebviewWindow, path: String, new_window: Option<bool>) -> Result<(), String> {
        let path = PathBuf::from(path);
        if !recent(&app).contains(&path) {
            return Err("That repository isn't in the recent list.".into());
        }
        if !is_repo(&path) {
            return Err(format!("{} isn't a git repository anymore.", path.display()));
        }
        super::open_repo(&app, path, (!new_window.unwrap_or(false)).then_some(window));
        Ok(())
    }

    #[tauri::command]
    pub fn pick_repo(app: AppHandle, window: WebviewWindow, new_window: Option<bool>) {
        super::pick_repo(&app, false, (!new_window.unwrap_or(false)).then_some(window));
    }

    #[tauri::command]
    pub fn forget_repo(app: AppHandle, path: String) {
        update_recent(&app, |list| list.retain(|p| p != Path::new(&path)));
    }

    /// Keep a page's view of its repository. By origin, so a page still unloading after its window
    /// switched (its server gone) can't file it under the new repository.
    #[tauri::command]
    pub fn remember_view(app: AppHandle, origin: String, state: String) {
        if state.len() > 1 << 20 {
            return;
        }
        if let Some(repo) = app.state::<Servers>().repo_at(&origin) {
            app.state::<Views>().0.lock().unwrap().insert(repo, state);
        }
    }

    /// What was kept for the page's repository, once.
    #[tauri::command]
    pub fn recall_view(app: AppHandle, origin: String) -> Option<String> {
        let repo = app.state::<Servers>().repo_at(&origin)?;
        app.state::<Views>().0.lock().unwrap().remove(&repo)
    }
}

/// `into`: the window to switch to the picked repository, rather than opening a new one.
fn pick_repo(app: &AppHandle, quit_if_cancelled: bool, into: Option<WebviewWindow>) {
    let handle = app.clone();
    app.dialog().file().set_title("Open a git repository").pick_folder(move |folder| {
        match folder.and_then(|f| f.into_path().ok()) {
            Some(path) => open_repo(&handle, path, into),
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
        None => pick_repo(app, true, None),
    }
}

/// Start a server for `path` and open a window on it, or switch window `into` to it. A window
/// that already has it is focused instead.
fn open_repo(app: &AppHandle, path: PathBuf, into: Option<WebviewWindow>) {
    let path = path.canonicalize().unwrap_or(path);
    let existing = app
        .state::<Servers>()
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(_, s)| s.repo == path)
        .map(|(label, _)| label.clone());
    if let Some(window) = existing.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        if let Err(err) = start(&app, &path, into) {
            eprintln!("legit: couldn't open {}: {err}", path.display());
            app.dialog()
                .message(err)
                .title("Couldn't open repository")
                .kind(MessageDialogKind::Error)
                .show(move |_| {});
            let quit = app.webview_windows().is_empty();
            if quit {
                pick_repo(&app, true, None);
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

fn start(app: &AppHandle, repo: &Path, into: Option<WebviewWindow>) -> Result<(), String> {
    let (child, url) = spawn_server(app, repo)?;
    let server = Server { repo: repo.to_path_buf(), child, origin: url.origin().ascii_serialization() };
    let name = repo_name(repo);
    let opened = repo.to_path_buf();
    if let Some(window) = into {
        // The page loads afresh from the new server, so nothing of the old repository carries over.
        if let Err(e) = window.navigate(url) {
            stop(server);
            return Err(e.to_string());
        }
        let _ = window.set_title(&name);
        let state = app.state::<Servers>();
        let mut servers = state.0.lock().unwrap();
        // If the window closed meanwhile, its server is gone already, and this one goes too.
        let old = match servers.get_mut(window.label()) {
            Some(slot) => std::mem::replace(slot, server),
            None => server,
        };
        drop(servers);
        thread::spawn(move || stop(old));
        update_recent(app, move |list| list.insert(0, opened));
        return Ok(());
    }

    let label = format!("repo{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
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
    app.state::<Servers>().0.lock().unwrap().insert(label, server);
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
