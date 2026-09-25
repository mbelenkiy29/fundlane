import type { SVGProps } from "react"

interface LogoProps extends SVGProps<SVGSVGElement> {
  size?: number
}

export const FUNDLANE_MARK_PATH =
  "M9 9h15l-4 4H9V9Zm0 7h11l-4 4H9v-4Zm0 7h7l-4 4H9v-4Z"

/** Square plus F holes, so the letter reveals the parent background on any `currentColor`. */
export const FUNDLANE_MARK_CUTOUT_PATH = `M0 0h32v32H0z ${FUNDLANE_MARK_PATH}`

/** Existing Fundlane “F” mark. The F is cut out so it stays readable on light or dark `currentColor`. */
export function Logo({ size = 24, className, ...props }: LogoProps) {
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
      <path d={FUNDLANE_MARK_CUTOUT_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}
