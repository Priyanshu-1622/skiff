import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PopoverProps = {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
};

export function Popover({ anchor, open, onClose, children, className }: PopoverProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const menu = elRef.current;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const menuW = menu ? menu.offsetWidth : 220;
      const menuH = menu ? menu.offsetHeight : 120;

      // try to place to the right of the anchor, vertically centered
      let left = rect.right - 8;
      let top = rect.top + rect.height / 2 - menuH / 2;

      // flip horizontally if overflowing
      if (left + menuW > viewportW - 8) {
        left = rect.left - menuW + 8;
      }
      // clamp vertically
      if (top < 8) top = 8;
      if (top + menuH > viewportH - 8) top = viewportH - menuH - 8;

      setPos({ top: Math.round(top), left: Math.round(left) });
    };

    // wait a frame for menu to render and measure
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", update); };
  }, [open, anchor]);

  if (!open) return null;

  const content = (
    <div>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div
        ref={elRef}
        className={className}
        role="menu"
        tabIndex={-1}
        style={{
          position: "fixed",
          zIndex: 9999,
          top: pos ? pos.top : "50%",
          left: pos ? pos.left : "50%",
          transform: pos ? undefined : "translate(-50%, -50%)",
        }}
      >
        {children}
      </div>
    </div>
  );

  const mount = document.body;
  return createPortal(content, mount);
}

export default Popover;
