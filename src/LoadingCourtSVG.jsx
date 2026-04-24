import { motion, useAnimation } from 'framer-motion';
import { useEffect } from 'react';

const LINE = '#a3e635';

const draw = (delay, duration) => ({
  hidden:  { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { delay, duration, ease: 'easeInOut' },
      opacity:    { delay, duration: 0.05 },
    },
  },
});

const Path = ({ d, strokeWidth, delay, duration, controls }) => (
  <motion.path
    d={d}
    fill="none"
    stroke={LINE}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    variants={draw(delay, duration)}
    initial="hidden"
    animate={controls}
  />
);

export default function LoadingCourtSVG() {
  const controls = useAnimation();

  useEffect(() => {
    // Wait for SVG to be painted so getTotalLength() returns correct values
    const id = requestAnimationFrame(() => controls.start('visible'));
    return () => cancelAnimationFrame(id);
  }, [controls]);

  return (
    <svg
      viewBox="0 0 900 480"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 'clamp(180px, 48vw, 290px)', display: 'block', margin: '0.9rem auto 0' }}
      aria-hidden="true"
    >
      <defs>
        <filter id="lc-ball-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient id="lc-court-bg" cx="50%" cy="50%" r="65%">
          <stop offset="0%"   stopColor="#1b3a5c"/>
          <stop offset="100%" stopColor="#0b1d2d"/>
        </radialGradient>
        <radialGradient id="lc-ball-fill" cx="33%" cy="28%" r="62%">
          <stop offset="0%"   stopColor="#f6ff86"/>
          <stop offset="55%"  stopColor="#c5e84e"/>
          <stop offset="100%" stopColor="#7ea82a"/>
        </radialGradient>
      </defs>

      <rect x="50" y="68" width="800" height="344" fill="url(#lc-court-bg)" rx="3"/>

      {/* 1. Outer boundary — top → right → bottom → left */}
      <Path d="M 50,68  L 850,68"   strokeWidth={12} delay={0.1}  duration={0.35} controls={controls} />
      <Path d="M 850,68 L 850,412"  strokeWidth={12} delay={0.45} duration={0.15} controls={controls} />
      <Path d="M 850,412 L 50,412"  strokeWidth={12} delay={0.6}  duration={0.35} controls={controls} />
      <Path d="M 50,412 L 50,68"    strokeWidth={12} delay={0.95} duration={0.15} controls={controls} />

      {/* 2. Net */}
      <Path d="M 450,68 L 450,412"  strokeWidth={5}  delay={1.2}  duration={0.4}  controls={controls} />

      {/* 3. Kitchen / NVZ lines */}
      <Path d="M 323,68 L 323,412"  strokeWidth={5}  delay={1.65} duration={0.4}  controls={controls} />
      <Path d="M 577,68 L 577,412"  strokeWidth={5}  delay={1.65} duration={0.4}  controls={controls} />

      {/* 4. Center service lines */}
      <Path d="M 50,240 L 323,240"  strokeWidth={4}  delay={2.05} duration={0.35} controls={controls} />
      <Path d="M 577,240 L 850,240" strokeWidth={4}  delay={2.05} duration={0.35} controls={controls} />

      {/* Ball */}
      <motion.circle
        cx="700" cy="240" r="14"
        fill="url(#lc-ball-fill)"
        filter="url(#lc-ball-glow)"
        variants={{
          hidden:  { scale: 0, opacity: 0 },
          visible: { scale: 1, opacity: 1, transition: { delay: 2.4, duration: 0.3, ease: 'easeOut' } },
        }}
        initial="hidden"
        animate={controls}
        style={{ transformOrigin: '700px 240px' }}
      />
    </svg>
  );
}
