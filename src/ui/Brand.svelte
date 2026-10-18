<script lang="ts">
  // The name in the header. Click it: the letters hop, spin or squish, and hearts and sparkles
  // burst out of it. Nothing else; it's for when you're bored.
  const LETTERS = [...'legit'];
  const GLYPHS = ['♥', '★', '✦', '●', '✿', '♥'];
  const COLORS = ['var(--theme2)', 'var(--theme)', 'var(--success)', 'var(--warn)', 'var(--danger)', '#ff8fc7', '#7cc7ff'];
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

  let letters: HTMLElement[] = $state([]);
  let last = -1;

  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MOVES: ((el: HTMLElement, i: number) => void)[] = [
    // A wave: each letter hops after the one before.
    (el, i) =>
      el.animate(
        [{ transform: 'none' }, { transform: 'translateY(-0.6em) scale(1.15)', offset: 0.35 }, { transform: 'translateY(0.08em) scaleY(0.85)', offset: 0.7 }, { transform: 'none' }],
        { duration: 520, delay: i * 70, easing: 'cubic-bezier(.3,.7,.4,1)' },
      ),
    // A spin each, the other way every other letter.
    (el, i) =>
      el.animate([{ transform: 'rotate(0)' }, { transform: `rotate(${i % 2 ? -360 : 360}deg) scale(1.2)`, offset: 0.7 }, { transform: 'rotate(360deg)' }], {
        duration: 700,
        delay: i * 50,
        easing: 'cubic-bezier(.5,0,.3,1)',
      }),
    // Squished flat, then boing.
    (el, i) =>
      el.animate(
        [
          { transform: 'none' },
          { transform: 'scale(1.4, 0.5)', offset: 0.25 },
          { transform: 'scale(0.8, 1.35) translateY(-0.3em)', offset: 0.5 },
          { transform: 'scale(1.1, 0.9)', offset: 0.75 },
          { transform: 'none' },
        ],
        { duration: 650, delay: i * 30, easing: 'ease-out' },
      ),
    // A rainbow, letter by letter.
    (el, i) =>
      el.animate(
        COLORS.slice(0, 5).map((color, k) => ({ color, transform: `translateY(${k % 2 ? -0.15 : 0}em)` })).concat({ color: 'var(--theme2)', transform: 'none' }),
        { duration: 900, delay: i * 60 },
      ),
  ];

  function burst(x: number, y: number) {
    for (let k = 0; k < 28; k++) {
      const p = document.createElement('span');
      p.className = 'brand-particle';
      p.textContent = pick(GLYPHS) + '\uFE0E'; // as text, so they take their colour, not emoji
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.color = pick(COLORS);
      p.style.fontSize = `${10 + Math.random() * 12}px`;
      document.body.append(p);
      // Up and out, then falling: a parabola sampled into keyframes.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const speed = 90 + Math.random() * 160;
      const [vx, vy] = [Math.cos(angle) * speed, Math.sin(angle) * speed];
      const spin = (Math.random() - 0.5) * 720;
      const frames = Array.from({ length: 9 }, (_, f) => {
        const t = f / 8;
        const dx = vx * t * 1.4;
        const dy = vy * t * 1.4 + 260 * t * t;
        return { transform: `translate(${dx}px, ${dy}px) rotate(${spin * t}deg) scale(${f === 0 ? 0.2 : 1 - t * 0.4})`, opacity: t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3 };
      });
      p.animate(frames, { duration: 900 + Math.random() * 500, easing: 'linear' }).finished.finally(() => p.remove());
    }
  }

  function play(e: MouseEvent) {
    if (still()) return;
    let m = Math.floor(Math.random() * MOVES.length);
    if (m === last) m = (m + 1) % MOVES.length;
    last = m;
    letters.forEach((el, i) => MOVES[m](el, i));
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    burst(e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
  }
</script>

<button class="brand" aria-label="legit" onclick={play}
  >{#each LETTERS as l, i (i)}<span class="letter" bind:this={letters[i]}>{l}</span>{/each}</button
>

<style>
  .brand {
    all: unset;
    cursor: pointer;
    font-weight: 700;
    font-size: var(--fs-xl);
    color: var(--theme2);
    letter-spacing: -0.02em;
    white-space: nowrap;
    flex-shrink: 0;
    user-select: none;
  }

  .letter {
    display: inline-block;
  }

  :global(.brand-particle) {
    position: fixed;
    z-index: 10000;
    pointer-events: none;
    line-height: 1;
    translate: -50% -50%;
  }
</style>
