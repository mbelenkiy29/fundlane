export async function marketingFontClasses(polished: boolean): Promise<string> {
  if (polished) {
    const { marketingMono } = await import('./fonts-polished')
    return marketingMono.variable
  }

  const { marketingHeading, marketingMono, marketingMetric } = await import('./fonts-current')
  return `${marketingHeading.variable} ${marketingMono.variable} ${marketingMetric.variable}`
}
