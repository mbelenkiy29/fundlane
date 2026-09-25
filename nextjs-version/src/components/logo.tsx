import { useId, type SVGProps } from "react"

interface LogoProps extends SVGProps<SVGSVGElement> {
  size?: number
}

export const FUNDLANE_MARK_PATH =
  "M9 9h15l-4 4H9V9Zm0 7h11l-4 4H9v-4Zm0 7h7l-4 4H9v-4Z"

/** Existing Fundlane “F” mark. The F is cut out so it stays readable on light or dark `currentColor`. */
export function Logo({ size = 24, className, ...props }: LogoProps) {
  const maskId = `fundlane-mark-${useId().replace(/:/g, "")}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...props}
    >
      <defs>
        <mask id={maskId}>
          <rect width="32" height="32" fill="#ffffff" />
          <path d={FUNDLANE_MARK_PATH} fill="#000000" />
        </mask>
      </defs>
      <rect width="32" height="32" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  )
}
