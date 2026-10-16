/* The room on screen, if any. Only setRoom changes it; every module reads the same live binding. */
export let room = null;
export const setRoom = (r) => { room = r; };
