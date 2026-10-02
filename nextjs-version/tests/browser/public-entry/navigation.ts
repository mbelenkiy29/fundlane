export function useSearchParams() { return new URLSearchParams(window.location.search) }
export function usePathname() { return window.location.pathname }
export function useRouter() { return { push: (path: string) => window.location.assign(path), replace: (path: string) => window.location.replace(path), prefetch: () => Promise.resolve() } }
