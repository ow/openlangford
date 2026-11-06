import { imageUrlForKey } from "./image-url";

/** Public URL for an image the pipeline extracted from a report PDF (R2). */
export function documentImageUrl(r2Key: string | null | undefined): string | null {
  return imageUrlForKey(r2Key);
}
