import { motion, useAnimation } from 'framer-motion';
import { useEffect, useState } from 'react';

// ── Court geometry (SVG units) ────────────────────────────────────────────
const VW = 900;
const VH = 480;

// Court rect inside the viewBox
const C = { x: 50, y: 68, w: 800, h: 344 };

// Derived landmarks
const NET_X  = C.x + C.w / 2;                     // 450  — centre net
const KIT    = Math.round((7 / 44) * C.w);         // 127  — 7ft in SVG units
const KIT_L  = NET_X - KIT;                        // 323  — left NVZ line
const KIT_R  = NET_X + KIT;                        // 577  — right NVZ line
const MID_Y  = C.y + C.h / 2;                      // 240  — horizontal midline
const FLOOR  = C.y + C.h;                          // 412  — bottom edge

// Ball starting position (left service box)
const BALL_X0 = KIT_L - 100;
const BALL_Y0 = MID_Y;

// ── Variant factory: pathLength 0 → 1 with staggered delays ──────────────
const draw = (delay, duration = 0.75) => ({
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { delay, duration, ease: [0.4, 0, 0.2, 1] },
      opacity:    { delay, duration: 0.01 },
    },
  },
});

// ── Fade-in variant ───────────────────────────────────────────────────────
const fadeIn = (delay) => ({
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { delay, duration: 0.45 } },
});

// ─────────────────────────────────────────────────────────────────────────
export default function PickleballCourt() {
  const ballCtrl = useAnimation();
  const [netDrawn, setNetDrawn] = useState(false);

  // Ball enters after all lines finish (~5.1 s)
  useEffect(() => {
    let alive = true;

    (async () => {
      await new Promise((r) => setTimeout(r, 5100));
      if (!alive) return;

      // Phase 1 — arc from left over the net to right
      await ballCtrl.start({
        cx:      [BALL_X0, 330, NET_X, 570, 650],
        cy:      [BALL_Y0, BALL_Y0 - 70, BALL_Y0 - 120, BALL_Y0 - 70, BALL_Y0],
        opacity: 1,
        transition: { duration: 1.3, ease: 'easeInOut' },
      });
      if (!alive) return;

      // Phase 2 — natural bounce settle on the right side
      await ballCtrl.start({
        cy: [BALL_Y0, BALL_Y0 - 52, BALL_Y0, BALL_Y0 - 24, BALL_Y0, BALL_Y0 - 9, BALL_Y0],
        transition: {
          duration: 0.9,
          times: [0, 0.17, 0.35, 0.53, 0.71, 0.86, 1],
          ease: 'easeOut',
        },
      });
    })();

    return () => { alive = false; };
  }, []);

  const netPath = `M ${NET_X},${C.y} L ${NET_X},${FLOOR}`;

  return (
    <div style={styles.page}>

      {/* ── Page header ───────────────────────────────────────────── */}
      <motion.header
        style={styles.header}
        initial={{ opacity: 0, y: -18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.15 }}
      >
        <span style={styles.headerEyebrow}>BMJ COURT</span>
        <h1 style={styles.headerTitle}>PICKLEBALL</h1>
        <span style={styles.headerSub}>COURT DIAGRAM</span>
      </motion.header>

      {/* ── SVG court ─────────────────────────────────────────────── */}
      <div style={styles.svgWrap}>
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ width: '100%', display: 'block' }}
          aria-label="Pickleball court diagram"
        >
          <defs>
            {/* ── Filters ─────────────────────────────────────────── */}
            <filter id="glow" x="-25%" y="-25%" width="150%" height="150%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>

            <filter id="netGlow" x="-40%" y="-10%" width="180%" height="120%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>

            <filter id="ballGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>

            {/* ── Court surface gradient ───────────────────────────── */}
            <radialGradient id="courtBg" cx="50%" cy="50%" r="65%">
              <stop offset="0%"   stopColor="#1b4262" />
              <stop offset="100%" stopColor="#0b1d2d" />
            </radialGradient>

            {/* ── Subtle court grid ────────────────────────────────── */}
            <pattern id="courtGrid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none"
                    stroke="rgba(255,255,255,0.025)" strokeWidth="0.7" />
            </pattern>

            {/* ── Ball gradient (highlights baked in) ─────────────── */}
            <radialGradient id="ballFill" cx="33%" cy="28%" r="62%">
              <stop offset="0%"   stopColor="#f6ff86" />
              <stop offset="55%"  stopColor="#c5e84e" />
              <stop offset="100%" stopColor="#7ea82a" />
            </radialGradient>
          </defs>

          {/* ── Court surface ────────────────────────────────────── */}
          <rect x={C.x} y={C.y} width={C.w} height={C.h}
                fill="url(#courtBg)" rx="2" />
          <rect x={C.x} y={C.y} width={C.w} height={C.h}
                fill="url(#courtGrid)" rx="2" />

          {/* ── 1. Outer boundary ────────────────────────────────── */}
          <motion.path
            d={`M ${C.x},${C.y} L ${C.x+C.w},${C.y} L ${C.x+C.w},${FLOOR} L ${C.x},${FLOOR} Z`}
            fill="none"
            stroke="#dff6ff"
            strokeWidth={3}
            filter="url(#glow)"
            variants={draw(0, 1.5)}
            initial="hidden"
            animate="visible"
          />

          {/* ── 2. Net ───────────────────────────────────────────── */}
          {/* Draw as solid, then swap to dashed once complete */}
          {!netDrawn && (
            <motion.path
              key="net-solid"
              d={netPath}
              fill="none"
              stroke="#ffd84d"
              strokeWidth={3.5}
              filter="url(#netGlow)"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{
                pathLength: { delay: 1.65, duration: 0.85, ease: 'easeInOut' },
                opacity:    { delay: 1.65, duration: 0.05 },
              }}
              onAnimationComplete={() => setNetDrawn(true)}
            />
          )}
          {netDrawn && (
            <motion.path
              key="net-dashed"
              d={netPath}
              fill="none"
              stroke="#ffd84d"
              strokeWidth={3.5}
              strokeDasharray="13 9"
              filter="url(#netGlow)"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.06 }}
            />
          )}

          {/* ── 3. Left NVZ / Kitchen line ───────────────────────── */}
          <motion.path
            d={`M ${KIT_L},${C.y} L ${KIT_L},${FLOOR}`}
            fill="none"
            stroke="#00d4ff"
            strokeWidth={2.5}
            filter="url(#glow)"
            variants={draw(2.6, 0.6)}
            initial="hidden"
            animate="visible"
          />

          {/* ── 4. Right NVZ / Kitchen line ──────────────────────── */}
          <motion.path
            d={`M ${KIT_R},${C.y} L ${KIT_R},${FLOOR}`}
            fill="none"
            stroke="#00d4ff"
            strokeWidth={2.5}
            filter="url(#glow)"
            variants={draw(3.3, 0.6)}
            initial="hidden"
            animate="visible"
          />

          {/* ── 5. Left centre service line ──────────────────────── */}
          <motion.path
            d={`M ${C.x},${MID_Y} L ${KIT_L},${MID_Y}`}
            fill="none"
            stroke="#dff6ff"
            strokeWidth={2}
            filter="url(#glow)"
            variants={draw(4.0, 0.45)}
            initial="hidden"
            animate="visible"
          />

          {/* ── 6. Right centre service line ─────────────────────── */}
          <motion.path
            d={`M ${KIT_R},${MID_Y} L ${C.x+C.w},${MID_Y}`}
            fill="none"
            stroke="#dff6ff"
            strokeWidth={2}
            filter="url(#glow)"
            variants={draw(4.55, 0.45)}
            initial="hidden"
            animate="visible"
          />

          {/* ── Labels ───────────────────────────────────────────── */}
          {/* NET */}
          <motion.text
            x={NET_X} y={C.y - 16}
            textAnchor="middle"
            fill="#ffd84d"
            fontSize="15"
            fontFamily="'Bebas Neue', sans-serif"
            letterSpacing="3"
            variants={fadeIn(2.55)}
            initial="hidden"
            animate="visible"
          >
            NET
          </motion.text>

          {/* NVZ left */}
          <motion.text
            x={(C.x + KIT_L) / 2} y={C.y - 16}
            textAnchor="middle"
            fill="#00d4ff"
            fontSize="15"
            fontFamily="'Bebas Neue', sans-serif"
            letterSpacing="3"
            variants={fadeIn(3.25)}
            initial="hidden"
            animate="visible"
          >
            NVZ
          </motion.text>

          {/* NVZ right */}
          <motion.text
            x={(KIT_R + C.x + C.w) / 2} y={C.y - 16}
            textAnchor="middle"
            fill="#00d4ff"
            fontSize="15"
            fontFamily="'Bebas Neue', sans-serif"
            letterSpacing="3"
            variants={fadeIn(3.95)}
            initial="hidden"
            animate="visible"
          >
            NVZ
          </motion.text>

          {/* 7 FT annotations below kitchen lines */}
          <motion.text
            x={(KIT_L + NET_X) / 2} y={FLOOR + 22}
            textAnchor="middle"
            fill="rgba(255,216,77,0.55)"
            fontSize="12"
            fontFamily="'Bebas Neue', sans-serif"
            letterSpacing="2"
            variants={fadeIn(2.9)}
            initial="hidden"
            animate="visible"
          >
            7 FT
          </motion.text>
          <motion.text
            x={(KIT_R + NET_X) / 2} y={FLOOR + 22}
            textAnchor="middle"
            fill="rgba(255,216,77,0.55)"
            fontSize="12"
            fontFamily="'Bebas Neue', sans-serif"
            letterSpacing="2"
            variants={fadeIn(3.6)}
            initial="hidden"
            animate="visible"
          >
            7 FT
          </motion.text>

          {/* ── Ball ─────────────────────────────────────────────── */}
          {/* Outer glow halo */}
          <motion.circle
            r={18}
            fill="#c5e84e"
            opacity={0.22}
            filter="url(#ballGlow)"
            initial={{ cx: BALL_X0, cy: BALL_Y0, opacity: 0 }}
            animate={ballCtrl}
          />
          {/* Main ball */}
          <motion.circle
            r={12}
            fill="url(#ballFill)"
            stroke="rgba(90,150,20,0.55)"
            strokeWidth={1}
            initial={{ cx: BALL_X0, cy: BALL_Y0, opacity: 0 }}
            animate={ballCtrl}
          />
        </svg>
      </div>

      {/* ── Legend ────────────────────────────────────────────────── */}
      <motion.footer
        style={styles.legend}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 5.0, duration: 0.7 }}
      >
        {[
          { color: '#dff6ff', label: 'Boundary / Service Line', dashed: false },
          { color: '#ffd84d', label: 'Net',                     dashed: true  },
          { color: '#00d4ff', label: 'Non-Volley Zone (Kitchen)', dashed: false },
        ].map(({ color, label, dashed }) => (
          <div key={label} style={styles.legendItem}>
            <div style={{
              width: '30px',
              height: '3px',
              ...(dashed
                ? { borderTop: `3px dashed ${color}` }
                : { background: color }),
              flexShrink: 0,
              boxShadow: `0 0 6px ${color}60`,
            }} />
            <span style={{ ...styles.legendText, color: `${color}99` }}>
              {label}
            </span>
          </div>
        ))}
      </motion.footer>

    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────
const styles = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse 120% 80% at 50% 40%, #0e2235 0%, #060c14 100%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '28px 20px 24px',
    fontFamily: "'Bebas Neue', sans-serif",
    gap: '0px',
  },
  header: {
    textAlign: 'center',
    marginBottom: '22px',
    lineHeight: 1,
  },
  headerEyebrow: {
    display: 'block',
    color: '#c5e84e',
    fontSize: 'clamp(11px, 1.4vw, 14px)',
    letterSpacing: '7px',
    marginBottom: '5px',
    textShadow: '0 0 12px rgba(197,232,78,0.6)',
  },
  headerTitle: {
    display: 'block',
    color: '#e2f8ff',
    fontSize: 'clamp(36px, 6vw, 58px)',
    letterSpacing: '10px',
    fontWeight: 'normal',
    textShadow: '0 0 30px rgba(226,248,255,0.15)',
  },
  headerSub: {
    display: 'block',
    color: '#4aa8c5',
    fontSize: 'clamp(13px, 1.8vw, 20px)',
    letterSpacing: '8px',
    marginTop: '3px',
  },
  svgWrap: {
    width: '100%',
    maxWidth: '860px',
  },
  legend: {
    display: 'flex',
    gap: '28px',
    marginTop: '18px',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  legendText: {
    fontSize: 'clamp(11px, 1.3vw, 13px)',
    letterSpacing: '1.5px',
  },
};
