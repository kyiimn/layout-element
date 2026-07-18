import * as React from 'react';

export type LogoProps = {
  className?: string;
};

export function Logo({ className }: LogoProps): React.ReactElement {
  return (
    <svg
      width={160}
      height={160}
      viewBox="0 0 160 160"
      role="img"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(28,26)">
        <line x1="0" y1="112" x2="100" y2="112" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <rect x="6" y="68" width="16" height="36" rx="3" fill="currentColor" />
        <rect x="32" y="40" width="16" height="64" rx="3" fill="currentColor" />
        <rect x="58" y="54" width="16" height="50" rx="3" fill="currentColor" />
        <rect x="84" y="72" width="16" height="32" rx="3" fill="currentColor" />
        <line x1="92" y1="48" x2="92" y2="68" stroke="#17C3B2" strokeWidth="2.5" strokeDasharray="1 5" strokeLinecap="round" />
        <rect x="92" y="40" width="15" height="15" rx="2" fill="#17C3B2" transform="rotate(45 92 40)" />
      </g>
    </svg>
  );
}