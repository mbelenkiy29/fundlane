import { AppError } from "../errors"
import { ARCHIVE_CATEGORIES, type ArchiveCategory } from "./contracts"

export function assertArchiveCategory(value: unknown): ArchiveCategory {
  if (!ARCHIVE_CATEGORIES.includes(value as ArchiveCategory)) {
    throw new AppError(422, "document_category_invalid", "Choose a supported document category before storing the file.")
  }
  return value as ArchiveCategory
}
