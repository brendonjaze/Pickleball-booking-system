import { createRoot } from 'react-dom/client';
import LoadingCourtSVG from './LoadingCourtSVG';

const el = document.getElementById('loading-court-root');
if (el) createRoot(el).render(<LoadingCourtSVG />);
