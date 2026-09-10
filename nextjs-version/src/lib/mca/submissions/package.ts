import "server-only"

import { applyCompression } from "./compress"
import type { OutgoingDocument, PackageResult } from "./contracts"
import { applyStamp } from "./stamps"
import { applyWatermark } from "./watermarks"

export async function prepareOutgoingPackage(input: {
  originals: OutgoingDocument[]
  funderId: string
}): Promise<PackageResult> {
  const originalChecksums = Object.fromEntries(input.originals.map((document) => [document.originalDocumentId, document.checksum]))
  let documents = input.originals
  documents = await applyStamp(documents, input.funderId)
  documents = await applyWatermark(documents, input.funderId)
  documents = await applyCompression(documents, input.funderId)
  return { documents, originalChecksums }
}
