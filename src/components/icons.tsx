import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base: IconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
  'aria-hidden': true
}

export const ChatIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

export const WhisperIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M3 12c0-4 4-8 9-8s9 4 9 8-4 8-9 8a10 10 0 0 1-3-.5L3 21l1.5-5A8 8 0 0 1 3 12z" />
    <path d="M8 11h.01M12 11h.01M16 11h.01" />
  </svg>
)

export const AgentsIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="10" cy="9" r="3.5" />
    <path d="M4.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" />
    <path d="m18 4 .7 1.8 1.8.7-1.8.7L18 9l-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
)

export const MeIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" />
  </svg>
)

export const SearchIcon = (props: IconProps) => (
  <svg {...base} {...props}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
)

export const BackIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="m15 18-6-6 6-6" /></svg>
)

export const MoreIcon = (props: IconProps) => (
  <svg {...base} {...props}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
)

export const PlusIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M12 5v14M5 12h14" /></svg>
)

export const AtIcon = (props: IconProps) => (
  <svg {...base} {...props}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" /></svg>
)

export const SendIcon = (props: IconProps) => (
  <svg {...base} {...props} strokeWidth={2}><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
)

export const CloseIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="m18 6-12 12M6 6l12 12" /></svg>
)

export const PinIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M12 17v5M9 7v5l-3 4h12l-3-4V7M9 7h6M9 7 7 4h10l-2 3" /></svg>
)

export const ArchiveIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M4 7h16v14H4zM3 3h18v4H3zM9 11h6" /></svg>
)

export const MemoryIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v.2A3.5 3.5 0 0 0 4.5 15 3.5 3.5 0 0 0 8 19.5h1.5zM14.5 4.5A3.5 3.5 0 0 1 18 8v.2a3.5 3.5 0 0 1 1.5 6.8 3.5 3.5 0 0 1-3.5 4.5h-1.5zM9.5 4.5v15M14.5 4.5v15M7 9h2.5M7 14h2.5M14.5 9H17M14.5 14H17" />
  </svg>
)

export const EditIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></svg>
)

export const UploadIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
)

export const StopIcon = (props: IconProps) => (
  <svg {...base} {...props}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
)

export const PlayIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="m8 5 11 7-11 7z" /></svg>
)

export const RefreshIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" /></svg>
)

export const SettingsIcon = (props: IconProps) => (
  <svg {...base} {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V21h-4v-.08A1.7 1.7 0 0 0 8.95 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.52-1H3v-4h.08A1.7 1.7 0 0 0 4.6 8.95a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.95 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15z" /></svg>
)

export const ChevronRightIcon = (props: IconProps) => (
  <svg {...base} {...props}><path d="m9 18 6-6-6-6" /></svg>
)
