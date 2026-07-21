import { ObjectId } from 'bson';

/**
 * Generate a new primary-key id in MongoDB ObjectId hex format (24 lowercase
 * hex chars). We keep this format post-migration so ids round-trip unchanged
 * through the API and client, and so foreign-key references survive the ETL
 * 1:1 without any remapping.
 */
export function newId(): string {
  return new ObjectId().toHexString();
}

/** True if a string is a well-formed 24-char ObjectId hex. */
export function isValidId(value: string): boolean {
  return /^[a-f0-9]{24}$/.test(value);
}
