// Isometric line-art machines (design/illustrations). Inline React SVG, never
// innerHTML; animatable parts are named groups whose CSS lives in a module.
import type { CSSProperties } from "react";
import { DotDisplay } from "./DotDisplay";
import styles from "./Machines.module.css";

const STROKE = { stroke: "#555555", strokeWidth: 1, strokeLinejoin: "round" as const };
const LEDS_TOP = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];
export type BoothLedge = "empty" | "envelope" | "card" | "question";

/** The response booth. Its display shows a system state or deadline countdown, never user text. */
export function Booth({ display, lit, leds, ledge, cardIn = false, label }: {
  display: string; lit: boolean; leds: "off" | "run" | "lit"; ledge: BoothLedge; cardIn?: boolean; label: string;
}) {
  const ledClass = leds === "run" ? styles.ledsRun : leds === "lit" ? styles.ledsLit : "";
  const ledge3d = "matrix(0.866 0.5 -0.866 0.5 102.8 311.5)";
  return <div className={styles.booth}>
    <svg className={`${styles.iso} ${styles.boothSvg}`} width="340" height="390" viewBox="0 30 340 390" role="img" aria-label={label}>
      <g {...STROKE}>
        <polygon points="140.0,212.0 330.5,322.0 200.6,397.0 10.1,287.0" fill="#1c1c1c" />
        <polygon points="10.1,301.0 200.6,411.0 200.6,397.0 10.1,287.0" fill="#151515" />
        <polygon points="330.5,336.0 200.6,411.0 200.6,397.0 330.5,322.0" fill="#111111" />
        <polygon points="145.2,85.0 290.7,169.0 207.5,217.0 62.1,133.0" fill="#1c1c1c" />
        <polygon points="62.1,283.0 207.5,367.0 207.5,217.0 62.1,133.0" fill="#151515" />
        <polygon points="290.7,319.0 207.5,367.0 207.5,217.0 290.7,169.0" fill="#111111" />
        <g transform="matrix(0.866 0.5 0 1 62.1 133)">
          <rect x="10" y="18" width="148" height="40" rx="3" fill="#0b0b0b" />
          <text x="84" y="80" textAnchor="middle" fontSize="7" letterSpacing="2.4" fill="#6a6a6a" stroke="none" fontFamily="Geist Mono, monospace">RESPONSE BOOTH</text>
          <rect x="44" y="138" width="80" height="6" rx="2" fill="#0a0a0a" />
        </g>
        <g transform="matrix(0.866 -0.5 0 1 207.5 217)">
          <line x1="20" y1="24" x2="76" y2="24" /><line x1="20" y1="32" x2="76" y2="32" /><line x1="20" y1="40" x2="76" y2="40" />
        </g>
        <polygon points="145.2,67.0 301.1,157.0 207.5,211.0 51.7,121.0" fill="#1c1c1c" />
        <polygon points="51.7,133.0 207.5,223.0 207.5,211.0 51.7,121.0" fill="#151515" />
        <polygon points="301.1,169.0 207.5,223.0 207.5,211.0 301.1,157.0" fill="#111111" />
        <polygon points="148.7,49.0 252.6,109.0 235.3,119.0 131.3,59.0" fill="#1c1c1c" />
        <polygon points="131.3,105.0 235.3,165.0 235.3,119.0 131.3,59.0" fill="#151515" />
        <polygon points="252.6,155.0 235.3,165.0 235.3,119.0 252.6,109.0" fill="#111111" />
        <g transform="matrix(0.866 0.5 0 1 131.3 59)">
          <rect x="46" y="15" width="28" height="17" rx="1.5" fill="none" stroke="#7a7a7a" />
          <polyline points="46,15 60,25 74,15" fill="none" stroke="#7a7a7a" />
          <g className={ledClass} stroke="none">
            {[...LEDS_TOP.map((x) => [x, 7]), ...[...LEDS_TOP].reverse().map((x) => [x, 39])].map(([x, y], i) =>
              <circle key={i} className={styles.led} cx={x} cy={y} r="1.6" style={{ "--d": `${i * 0.05}s` } as CSSProperties} />)}
          </g>
        </g>
      </g>
      <g strokeWidth="1" strokeLinejoin="round">
        {(ledge === "empty") && <g transform={ledge3d}><rect x="0" y="0" width="64" height="24" rx="2" fill="none" stroke="#3d3d3d" strokeDasharray="3 3" /></g>}
        {(ledge === "envelope" || ledge === "question") && <g transform={ledge3d}>
          <rect x="0" y="0" width="64" height="24" rx="2" fill="#222222" stroke="#7a7a7a" />
          <polyline points="0,0 32,14 64,0" fill="none" stroke="#7a7a7a" />
          {ledge === "question" && <text x="52" y="20" fontSize="9" fill="#a3a3a3" stroke="none" fontFamily="Geist Mono, monospace">?</text>}
        </g>}
        {ledge === "card" && <g className={cardIn ? styles.cardIn : ""}><g transform={ledge3d}>
          <rect x="0" y="0" width="64" height="24" rx="2" fill="#222222" stroke="#8a8a8a" />
          <line x1="8" y1="7" x2="30" y2="7" stroke="#5a5a5a" /><line x1="8" y1="12" x2="26" y2="12" stroke="#5a5a5a" />
          <line x1="8" y1="17" x2="30" y2="17" stroke="#5a5a5a" />
          <g className={styles.litMark}><circle cx="48" cy="12" r="6" fill="#f7f7f7" stroke="none" />
            <polygon points="48,8.4 48.88,10.79 51.42,10.89 49.43,12.46 50.12,14.91 48,13.5 45.88,14.91 46.57,12.46 44.58,10.89 47.12,10.79" fill="#141414" stroke="none" /></g>
        </g></g>}
      </g>
    </svg>
    <div className={styles.face} aria-hidden="true"><div className={styles.faceInner}>
      <DotDisplay text={display.padEnd(6, " ").slice(0, 6)} label="" tone={lit ? "lit" : "dim"} dot={3} dotGap={1} glyphGap={4} off="face" scramble />
    </div></div>
  </div>;
}

const COLUMN_LEDS = [36, 48, 60, 72, 84, 96].flatMap((y) => [[22, y], [38, y]]);
const GRID = [6, 9, 12, 15, 18, 23, 26, 29, 32, 35, 40, 43, 46, 49, 52].flatMap((x) => [10, 13, 16, 19, 22, 25, 28].map((y) => [x, y]));
const DOTS_404: [number, number][] = [[15, 10], [12, 13], [15, 13], [9, 16], [15, 16], [6, 19], [15, 19], [6, 22], [9, 22], [12, 22], [15, 22], [18, 22], [15, 25], [15, 28],
  [26, 10], [29, 10], [32, 10], [23, 13], [35, 13], [23, 16], [32, 16], [35, 16], [23, 19], [29, 19], [35, 19], [23, 22], [26, 22], [35, 22], [23, 25], [35, 25], [26, 28], [29, 28], [32, 28],
  [49, 10], [46, 13], [49, 13], [43, 16], [49, 16], [40, 19], [49, 19], [40, 22], [43, 22], [46, 22], [49, 22], [52, 22], [49, 25], [49, 28]];

/**
 * The portal stamp press. `stamping` plays the 2.4 s one-shot after the user's
 * explicit confirmation (never instead of it); `loop404` stamps "404" on a card.
 */
export function Press({ mode, label }: { mode: "idle" | "stamping" | "stamped" | "loop404"; label: string }) {
  const modeClass = mode === "stamping" ? styles.stamping : mode === "stamped" ? styles.stamped : mode === "loop404" ? styles.loop : "";
  return <div className={`${styles.press} ${modeClass}`}>
    <svg className={`${styles.iso} ${styles.pressSvg}`} viewBox="16 40 316 330" role="img" aria-label={label}>
      <g {...STROKE}>
        <polygon points="150.0,172.0 323.2,272.0 193.3,347.0 20.1,247.0" fill="#1c1c1c" />
        <polygon points="20.1,261.0 193.3,361.0 193.3,347.0 20.1,247.0" fill="#151515" />
        <polygon points="323.2,286.0 193.3,361.0 193.3,347.0 323.2,272.0" fill="#111111" />
        <polygon points="202.0,82.0 253.9,112.0 219.3,132.0 167.3,102.0" fill="#1c1c1c" />
        <polygon points="167.3,232.0 219.3,262.0 219.3,132.0 167.3,102.0" fill="#151515" />
        <polygon points="253.9,242.0 219.3,262.0 219.3,132.0 253.9,112.0" fill="#111111" />
        <g transform="matrix(0.866 0.5 0 1 167.3 128)" stroke="none">
          {COLUMN_LEDS.map(([x, y], i) => <circle key={i} className={styles.led} cx={x} cy={y} r="1.8" style={{ "--d": `${i * 0.09}s` } as CSSProperties} />)}
        </g>
        <g transform="matrix(0.866 -0.5 0 1 219.3 132)"><circle cx="20" cy="44" r="5" fill="#151515" /></g>
        <g transform="translate(236.6 166)"><g className={styles.lever}>
          <line x1="0" y1="0" x2="28" y2="-38" stroke="#8a8a8a" strokeWidth="1.5" />
          <circle cx="28" cy="-38" r="5.5" fill="#151515" stroke="#8a8a8a" />
        </g></g>
        <g className={styles.slide}>
          {mode === "loop404" ? <g transform="matrix(0.866 0.5 -0.866 0.5 134.4 253)">
            <rect x="0" y="0" width="56" height="38" rx="2" fill="#202020" stroke="#8a8a8a" />
            <g fill="#2c2c2c" stroke="none">{GRID.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.8" />)}</g>
            <g className={styles.dim404} fill="#6b6b6b" stroke="none">{DOTS_404.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.15" />)}</g>
            <g className={styles.lit404} fill="#f7f7f7" stroke="none">{DOTS_404.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.15" />)}</g>
          </g> : <g transform="matrix(0.866 0.5 -0.866 0.5 134.4 253)">
            <rect x="0" y="0" width="56" height="38" rx="2" fill="#222222" stroke="#7a7a7a" />
            <polyline points="0,0 28,20 56,0" fill="none" stroke="#7a7a7a" />
            <g className={styles.mark} stroke="none">
              <circle className={styles.markDot} cx="28" cy="28" r="6.5" />
              <polygon points="28,24.4 28.88,26.79 31.42,26.89 29.43,28.46 30.12,30.91 28,29.5 25.88,30.91 26.57,28.46 24.58,26.89 27.12,26.79" fill="#141414" />
            </g>
          </g>}
        </g>
        <g className={styles.head}>
          <polygon points="143.1,144.0 150.0,148.0 143.1,152.0 136.1,148.0" fill="#1c1c1c" />
          <polygon points="136.1,222.0 143.1,226.0 143.1,152.0 136.1,148.0" fill="#151515" />
          <polygon points="150.0,222.0 143.1,226.0 143.1,152.0 150.0,148.0" fill="#111111" />
        </g>
        <polygon points="193.3,99.0 227.9,119.0 150.0,164.0 115.4,144.0" fill="#1c1c1c" />
        <polygon points="115.4,168.0 150.0,188.0 150.0,164.0 115.4,144.0" fill="#151515" />
        <polygon points="227.9,143.0 150.0,188.0 150.0,164.0 227.9,119.0" fill="#111111" />
        <g className={styles.head}>
          <polygon points="136.1,198.0 184.6,226.0 150.0,246.0 101.5,218.0" fill="#1c1c1c" />
          <polygon points="101.5,248.0 150.0,276.0 150.0,246.0 101.5,218.0" fill="#151515" />
          <polygon points="184.6,256.0 150.0,276.0 150.0,246.0 184.6,226.0" fill="#111111" />
          <g transform="matrix(0.866 0.5 0 1 101.5 218)"><line x1="0" y1="22" x2="56" y2="22" /></g>
        </g>
      </g>
    </svg>
  </div>;
}
