/**
 * Building ViewModel — what list rows / detail cards render.
 *
 * Per docs/05 §9.8: the wire `Building` carries split-out address
 * components (address / city / block / parcel / subparcel) that the UI
 * usually composes into one line. The adapter folds them into
 * `addressLine` + `parcelSummary`, computed once.
 */
export interface BuildingViewModel {
  id: string;
  projectId: string;
  /** Verbatim "street + number" — e.g. "הרצל 10". */
  address: string;
  /** Verbatim city — e.g. "תל אביב". */
  city: string;
  /** "address, city" composed for list rows. */
  addressLine: string;
  /** "גוש 6638 חלקה 12 תת-חלקה 4" — or null if all three are empty. */
  parcelSummary: string | null;
  /** Verbatim apt count (zero is legal — empty building pending survey). */
  aptCount: number;
  notes: string | null;
  isArchived: boolean;
  createdRelative: string;
  createdAtIso: string;
}
