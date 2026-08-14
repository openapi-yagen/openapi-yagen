import {useEffect, useRef, useState, type ReactNode, type SyntheticEvent} from 'react';
import styles from './styles.module.css';

// A "?" button that reveals a description on click - <details>/<summary> gives click-to-toggle
// disclosure natively (keyboard accessible, no positioning JS needed), styled as a small round
// button instead of the default marker+text. `open` is kept in React state (synced from the
// native 'toggle' event) purely so an outside click can force it closed too - plain <details>
// only closes via clicking its own <summary> again, which left stray popovers open and cluttering
// the screen otherwise.
export default function InfoPopover({text}: {text?: string}): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, [open]);

  if (!text) return null;

  return (
    <details
      ref={ref}
      className={styles.infoPopover}
      open={open}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}>
      <summary className={styles.infoButton} aria-label="More info">
        ?
      </summary>
      <div className={styles.infoContent}>{text}</div>
    </details>
  );
}
