/* People this device has blocked: their messages fold away here, and only here; they aren't told. */
import { t } from "./text.js?v=dev";
import { toast, confirmSheet } from "./dom.js?v=dev";
import { StoredList, KEYS } from "./storage.js?v=dev";
import { room } from "./session.js?v=dev";
import { renderView } from "./chat.js?v=dev";

const MAX_BLOCKED = 500;
const list = new StoredList(KEYS.blocked);
const blocked = new Set(list.all());
export const isBlocked = (id) => blocked.has(id);

export async function setBlocked(id, on) {
  const name = room?.who(id)?.name || "";
  if (on && !(await confirmSheet(t("blockTitle", { who: room.nameOf(id) }), t("blockBody"), t("block")))) return;
  if (on) blocked.add(id); else blocked.delete(id);
  list.save([...blocked].slice(-MAX_BLOCKED));
  toast(t(on ? "blockedToast" : "unblockedToast", { name }));
  if (room && !room.gone) renderView();
}
