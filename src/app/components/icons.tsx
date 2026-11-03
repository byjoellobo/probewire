/** Stroke icons drawn on a 24px grid. */
import type { JSX } from 'preact';

interface IconProps {
  size?: number;
  title?: string;
}

function Svg({ size = 20, title, children }: IconProps & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : <></>}
      {children}
    </svg>
  );
}

/** Mark: a square wave over a probe hook, in gold. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="#1b302c" stroke="#335a52" />
      <path d="M5 21h5V11h6v10h5V11h6" fill="none" stroke="#d9ae4e" stroke-width="2.4" stroke-linejoin="miter" />
    </svg>
  );
}

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5M8.5 11h5M11 8.5v5" />
  </Svg>
);

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5M8.5 11h5" />
  </Svg>
);

export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4M8 12h8" />
  </Svg>
);

export const IconCursors = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3v18M17 3v18M7 12h10" />
  </Svg>
);

export const IconClear = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />
  </Svg>
);

export const IconDevice = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="3" width="12" height="18" rx="2" />
    <path d="M9 7h6M9 11h6M10 21v-3M14 21v-3" />
  </Svg>
);

export const IconDecode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8l2-3h4l2 3-2 3H5zM13 8l2-3h4l2 3-2 3h-4zM3 19h3v-4h4v4h4v-4h4v4h3" />
  </Svg>
);

export const IconLibrary = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
);

export const IconWave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 16h4V8h5v8h4V8h5v8h2" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 6.1A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.2 7.6C3.6 9.4 2 12 2 12s3.5 6 10 6c1.5 0 2.8-.3 4-.8" />
  </Svg>
);
