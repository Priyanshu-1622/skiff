/* ============================================================
   Icons — minimal stroke set. 16px viewBox by default.
   Single-color via currentColor, 1.5px stroke to match the
   calm/terminal vibe.

   Ported from the Claude Design handoff. Same SVG paths,
   re-shaped into ESM exports with TypeScript.
   ============================================================ */

import type { SVGProps, ReactNode } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "fill" | "stroke"> {
  size?: number;
  stroke?: number;
  fill?: string;
  children?: ReactNode;
  d?: string;
}

const Icon = ({
  d,
  size = 16,
  stroke = 1.5,
  fill = "none",
  children,
  ...rest
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={fill}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

export const Skiff = (p: IconProps) => (
  <Icon {...p} size={p.size ?? 18}>
    {/* boat hull + sail */}
    <path d="M2 11.5 L14 11.5 L12.5 14 L3.5 14 Z" />
    <path d="M8 2 L8 11.5" />
    <path d="M8 3.2 L13 10 L8 10 Z" fill="currentColor" stroke="none" opacity="0.85" />
  </Icon>
);

// ── team-mode icons ──
export const User = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13 a4.5 4.5 0 0 1 9 0" /></Icon>
);
export const Users = (p: IconProps) => (
  <Icon {...p}><circle cx="6" cy="5.5" r="2.2" /><path d="M2 12.5 a4 4 0 0 1 8 0" /><path d="M10.5 3.6 a2.2 2.2 0 0 1 0 3.8" /><path d="M11 9.2 a4 4 0 0 1 3 3.3" /></Icon>
);
export const Shield = (p: IconProps) => (
  <Icon {...p}><path d="M8 1.8 L13 3.4 V8 c0 3.2 -2.2 5 -5 6.2 C5.8 13 3.6 11.2 3.6 8 V3.4 Z" /><path d="M5.9 8 L7.4 9.5 L10.3 6.3" /></Icon>
);
export const Clock = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.6 V8 L10.3 9.4" /></Icon>
);
export const Copy = (p: IconProps) => (
  <Icon {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5 a1 1 0 0 1 -1 -1 V3.5 a1 1 0 0 1 1 -1 H9 a1 1 0 0 1 1 1" /></Icon>
);
export const Power = (p: IconProps) => (
  <Icon {...p}><path d="M8 2 V7.5" /><path d="M4.6 4.6 a4.8 4.8 0 1 0 6.8 0" /></Icon>
);
export const LogIn = (p: IconProps) => (
  <Icon {...p}><path d="M9 2.5 H12.5 a1 1 0 0 1 1 1 V12.5 a1 1 0 0 1 -1 1 H9" /><path d="M2.5 8 H10 M7.5 5 L10.5 8 L7.5 11" /></Icon>
);

export const Server = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3" width="11" height="4" rx="1" />
    <rect x="2.5" y="9" width="11" height="4" rx="1" />
    <circle cx="5" cy="5" r="0.6" fill="currentColor" stroke="none" />
    <circle cx="5" cy="11" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const Folder = (p: IconProps) => (
  <Icon
    {...p}
    d="M2.5 5 V12 a1 1 0 0 0 1 1 H12.5 a1 1 0 0 0 1 -1 V6 a1 1 0 0 0 -1 -1 H7.5 L6 3.5 H3.5 a1 1 0 0 0 -1 1 Z"
  />
);

export const Key = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="8" r="2.5" />
    <path d="M7.5 8 L13.5 8 M11.5 8 V10 M13.5 8 V10" />
  </Icon>
);

export const Terminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M5 7 L7 9 L5 11 M9 11 H11" />
  </Icon>
);

export const Star = (p: IconProps) => (
  <Icon
    {...p}
    d="M8 2.5 L9.6 6 L13.5 6.5 L10.7 9.2 L11.4 13 L8 11.2 L4.6 13 L5.3 9.2 L2.5 6.5 L6.4 6 Z"
  />
);

export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3 V13 M3 8 H13" />
  </Icon>
);

export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10 L13 13" />
  </Icon>
);

export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4 L12 12 M12 4 L4 12" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p} d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
);

export const Eye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 8 C 4 4 6 3 8 3 C 10 3 12 4 14 8 C 12 12 10 13 8 13 C 6 13 4 12 2 8 Z" />
    <circle cx="8" cy="8" r="1.5" />
  </Icon>
);

export const EyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8 C 4.5 5 6 4 8 4" />
    <path d="M9 4.2 C 11 4.6 12.6 6 14 8 C 13 9.6 12 10.6 11 11.3" />
    <path d="M2 2 L14 14" />
  </Icon>
);

export const Settings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5 V3 M8 13 V14.5 M3 8 H1.5 M14.5 8 H13 M4 4 L5 5 M11 11 L12 12 M4 12 L5 11 M11 5 L12 4" />
  </Icon>
);

export const Bolt = (p: IconProps) => (
  <Icon {...p} d="M8.5 1 L3 9 H7 L6.5 15 L13 7 H9 Z" />
);

export const Lock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" />
  </Icon>
);

export const Globe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8 H13.5 M8 2.5 C 10 5 10 11 8 13.5 C 6 11 6 5 8 2.5" />
  </Icon>
);

export const Tag = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 8.5 L8.5 2.5 H13.5 V7.5 L7.5 13.5 Z" />
    <circle cx="11" cy="5" r="0.7" fill="currentColor" stroke="none" />
  </Icon>
);

export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8 H13 M9 4 L13 8 L9 12" />
  </Icon>
);

export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5 V11.5 M8 5 V5.5" />
  </Icon>
);

export const Warn = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2 L14 13 H2 Z" />
    <path d="M8 6.5 V9.5 M8 11 V11.2" />
  </Icon>
);

export const Cross = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" />
  </Icon>
);

export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.5 3.5 L4.6 4.6 M11.4 11.4 L12.5 12.5 M3.5 12.5 L4.6 11.4 M11.4 4.6 L12.5 3.5" />
  </Icon>
);

export const Moon = (p: IconProps) => (
  <Icon
    {...p}
    d="M12.5 9.5 A 5 5 0 1 1 6.5 3.5 A 4 4 0 0 0 12.5 9.5 Z"
  />
);

export const Dots = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const Chevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4 L10 8 L6 12" />
  </Icon>
);

export const Filter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3.5 H13.5 L9.5 8 V13 L6.5 11 V8 Z" />
  </Icon>
);

export const Refresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8 a5 5 0 0 1 9 -3" />
    <path d="M12 2.5 V5.5 H9" />
    <path d="M13 8 a5 5 0 0 1 -9 3" />
    <path d="M4 13.5 V10.5 H7" />
  </Icon>
);

export const Empty = (p: IconProps) => (
  <Icon {...p} size={p.size ?? 22}>
    <rect x="3" y="3" width="10" height="3" rx="1" />
    <rect x="3" y="7" width="10" height="3" rx="1" />
    <rect x="3" y="11" width="10" height="3" rx="1" />
    <path d="M5 4.5 H5.01 M5 8.5 H5.01 M5 12.5 H5.01" />
  </Icon>
);

/* Grouped namespace import — matches the `I.X` pattern from the Design
   handoff so screen code can drop in with minimal edits.

   Use either:
     import { Server } from "@/components/icons";
   or:
     import * as I from "@/components/icons";  ->  <I.Server />
*/
