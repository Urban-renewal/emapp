import type { DocumentType } from '@emapp/shared-types';

export interface DocumentViewModel {
  id: string;
  name: string;
  type: DocumentType;
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
