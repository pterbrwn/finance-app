import * as React from "react"

const MOBILE_BREAKPOINT = 600
const mobileQuery = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function getIsMobile() {
  if (typeof window === "undefined") return false
  return window.matchMedia(mobileQuery).matches
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(getIsMobile)

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(mobileQuery)
    const onChange = () => setIsMobile(mediaQuery.matches)

    mediaQuery.addEventListener("change", onChange)
    return () => mediaQuery.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
