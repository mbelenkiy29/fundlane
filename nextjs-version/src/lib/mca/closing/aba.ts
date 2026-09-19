import "server-only"

import { AppError } from "../errors"

/** US ABA routing: 9 digits and 3(d0+d3+d6)+7(d1+d4+d7)+(d2+d5+d8) ≡ 0 (mod 10). */
export function assertUsAbaRoutingNumber(value: string): string {
  const routing = String(value).replace(/\D/g, "")
  if (!/^\d{9}$/.test(routing)) {
    throw new AppError(422, "routing_number_invalid", "Enter a 9-digit routing number.")
  }
  const d = routing.split("").map((digit) => Number(digit))
  const checksum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)
  if (checksum % 10 !== 0) {
    throw new AppError(422, "routing_number_invalid", "Enter a valid ABA routing number.")
  }
  return routing
}
