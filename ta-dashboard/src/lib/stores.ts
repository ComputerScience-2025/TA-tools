import {persisted} from "svelte-persisted-store";

export const GITHUB_PAT = persisted("GITHUB_PAT", "");
export const darkMode = persisted("darkMode", false);
