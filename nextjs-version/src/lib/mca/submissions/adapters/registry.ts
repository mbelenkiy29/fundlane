import "server-only"

import type { FunderAdapter } from "../contracts"
import { bittyAdvanceAdapter } from "./bitty-advance"
import { canCapitalAdapter } from "./can-capital"
import { channelPartnersCapitalAdapter } from "./channel-partners-capital"
import { crediblyAdapter } from "./credibly"
import { everestBusinessFundingAdapter } from "./everest-business-funding"
import { expansionCapitalGroupAdapter } from "./expansion-capital-group"
import { fintegraAdapter } from "./fintegra"
import { foraFinancialAdapter } from "./fora-financial"
import { forwardFinancingAdapter } from "./forward-financing"
import { fundomateAdapter } from "./fundomate"
import { headwayCapitalAdapter } from "./headway-capital"
import { ideaFinancialAdapter } from "./idea-financial"
import { kapitusAdapter } from "./kapitus"
import { lendiniAdapter } from "./lendini"
import { lendrAdapter } from "./lendr"
import { ondeckAdapter } from "./ondeck"
import { peacSolutionsAdapter } from "./peac-solutions"
import { plexeAdapter } from "./plexe"
import { quantumLendsAdapter } from "./quantum-lends"
import { rapidFinanceAdapter } from "./rapid-finance"

const adapters = new Map<string, FunderAdapter>()

for (const adapter of [
  expansionCapitalGroupAdapter,
  kapitusAdapter,
  fintegraAdapter,
  quantumLendsAdapter,
  channelPartnersCapitalAdapter,
  forwardFinancingAdapter,
  fundomateAdapter,
  rapidFinanceAdapter,
  headwayCapitalAdapter,
  plexeAdapter,
  foraFinancialAdapter,
  ideaFinancialAdapter,
  peacSolutionsAdapter,
  canCapitalAdapter,
  bittyAdvanceAdapter,
  lendiniAdapter,
  lendrAdapter,
  everestBusinessFundingAdapter,
  ondeckAdapter,
  crediblyAdapter,
]) {
  adapters.set(adapter.slug, adapter)
}

export function registerAdapter(adapter: FunderAdapter): void {
  adapters.set(adapter.slug, adapter)
}

export function getAdapter(slug: string): FunderAdapter | undefined {
  return adapters.get(slug)
}

export function listAdapters(): FunderAdapter[] {
  return [...adapters.values()]
}
