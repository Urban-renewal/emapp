export interface DocumentViewModel {
  id: string;
  name: string;
  /** Free text on the BE (seeds/imports use agreement/blueprint/regulation);
   *  `typeLabel` is the resolved Hebrew/English display string. */
  type: string;
  typeLabel: string;
  mimeType: string;
  sizeBytes: number;
  /** Human-readable size — "1.2 MB" / "523 KB" / "84 B". */
  sizeLabel: string;
  isArchived: boolean;
  createdRelative: string;
  projectId: string | null;
  apartmentId: string | null;
}
