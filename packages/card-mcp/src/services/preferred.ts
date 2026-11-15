/**
 * The one value a tool answers with when it has to pick from a contact's
 * list (emails, phones, URLs, addresses): the preferred one, the default
 * Apple clients and Nextcloud pick, else the first.
 *
 * With a type, only values carrying that TYPE token count (one typed
 * `home/work` matches either), case-insensitive; none of that type is
 * undefined, never a value of another type, because "her work email"
 * answered with her home one is a wrong answer that looks like a right one.
 *
 * Tools that return a whole list leave it in card order with `pref` on each
 * entry, rather than reordering it: the order is the card's, and the caller
 * can see which entry is preferred without it.
 */
export function pickPreferred<T extends { type?: string; pref?: boolean }>(
  values: readonly T[],
  type?: string,
): T | undefined {
  const wanted = type?.trim().toLowerCase();
  const pool = wanted
    ? values.filter((v) => v.type?.toLowerCase().split("/").includes(wanted))
    : values;
  return pool.find((v) => v.pref) ?? pool[0];
}
