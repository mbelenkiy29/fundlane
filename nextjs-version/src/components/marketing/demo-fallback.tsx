export function DemoFallback({ supportEmail }: { supportEmail: string | null }) {
  return (
    <p className="fl-form-notice" role="status">
      Demo requests are temporarily unavailable. {supportEmail ? <>Please email us at <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</> : "Please check back soon."}
    </p>
  )
}
