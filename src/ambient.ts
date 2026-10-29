import type { Activity } from "./model";

export const species = { cat: "小猫", bunny: "兔子", bear: "小熊", robot: "机器人" } as const;
export const actions = { typing: "敲键盘", drink: "喝水", snack: "吃零食", stretch: "伸展", talk: "聊天", rest: "休息", fish: "钓鱼" } as const;
export type Species = keyof typeof species;
export type AmbientAction = keyof typeof actions;
export interface Appearance { species: Species; action: AmbientAction; phase: number }
const speciesKeys = Object.keys(species) as Species[];
const routines: Record<Activity, AmbientAction[]> = {
 working: ["typing", "typing", "drink", "typing", "stretch", "snack"],
 meeting: ["talk", "talk", "drink", "talk", "stretch", "snack"],
 discussing: ["talk", "typing", "talk", "drink", "snack", "stretch"],
 resting: ["drink", "snack", "rest", "stretch", "drink", "talk"],
 fishing: ["fish", "fish", "drink", "fish", "snack", "stretch"],
 offline: ["rest"],
};
export const speech: Record<AmbientAction, string[]> = {
 typing: ["哒哒哒…", "手指热身中"], drink: ["补点水～", "咕嘟咕嘟"],
 snack: ["咔嚓！", "零食时间"], stretch: ["伸个懒腰", "动一动～"],
 talk: ["聊两句～", "嗯嗯！"], rest: ["呼…", "眯一会儿"], fish: ["鱼呢？", "再等一下～"],
};
export function appearance(id: string, activity: Activity, tick: number): Appearance {
 const seed = Array.from(id).reduce((n, c) => (n * 31 + c.codePointAt(0)!) >>> 0, 0);
 const routine = routines[activity];
 return { species: speciesKeys[seed % speciesKeys.length], action: routine[(Math.floor((tick + seed % 4) / 4) + seed) % routine.length], phase: seed % 7 };
}

// All coordinates are local to the character so the camera and hit area stay stable.
export function characterArt(look: Appearance, color: string, sleeping: boolean): string {
 const ears: Record<Species, string> = {
  cat: '<path d="M-14 -10v-13h7v9H7v-9h7v13" fill="currentColor"/><path d="M-11 -19v6M11 -19v6" stroke="#e1b3b1" stroke-width="3"/>',
  bunny: '<path d="M-11 -11v-23h7v23M4 -11v-26h7v26" fill="currentColor"/><path d="M-7 -29v13M8 -32v15" stroke="#e4b9bd" stroke-width="3"/>',
  bear: '<path d="M-17 -8v-10h10v8M7 -10v-8h10v10" fill="currentColor"/><path d="M-14 -14h4M10 -14h4" stroke="#52443f" stroke-width="4"/>',
  robot: '<path d="M0 -15v-10" stroke="#acbac5" stroke-width="3"/><rect x="-3" y="-28" width="6" height="5" fill="#d5c387"/><path d="M-20 -6h5v14h-5M15 -6h5v14h-5" fill="#acbac5"/>',
 };
 const eyes = sleeping ? 'M-9 -3h5M4 -3h5' : 'M-7 -5v4M7 -5v4';
 const props: Record<AmbientAction, string> = {
  typing: '<g class="keyboard"><path d="M-20 12h40v10h-40z" fill="#444f60"/><path d="M-15 16h30m-25 4h20" stroke="#a5b4c1" stroke-width="2"/></g><g class="hands typing-hands" fill="currentColor"><path d="M-13 8h8v8h-8z"/><path class="right-hand" d="M5 8h8v8H5z"/></g><path class="typing-spark" d="M21 -11v-5m4 6h5" stroke="#d5c387" stroke-width="2"/>',
  drink: '<g class="drink-hand"><path d="M8 7h8v6H8" fill="currentColor"/><path d="M12 -1h11v14H12zM23 2h4v7h-4" fill="#a4c9d2"/><path d="M14 2h7" stroke="#e4f1e7" stroke-width="2"/></g>',
  snack: '<g class="snack-hand"><path d="M8 5h7v7H8" fill="currentColor"/><path d="M12 -2h10v10H12z" fill="#d6b17c"/><path d="M15 1h2m2 4h2" stroke="#80624e" stroke-width="2"/></g><path class="crumb" d="M23 10h3m-6 5h2" stroke="#d6b17c" stroke-width="2"/>',
  stretch: '<g class="stretch-arms" fill="currentColor"><path d="M-14 0h-8v-12h6v7h5zM14 0h8v-12h-6v7h-5z"/></g>',
  talk: '<g class="talk-hand"><path d="M13 4h8v-9h5v14H13z" fill="currentColor"/></g><path class="talk-mouth" d="M-2 5h4v3h-4z" fill="#3e333a"/>',
  rest: '<text x="21" y="-18" class="zzz rest-z">z</text><text x="29" y="-27" class="zzz rest-z second-z">z</text>',
  fish: '<path d="M12 8l18 -30 16 12" stroke="#c8ac83" fill="none" stroke-width="2"/><path d="M46 -10v26" stroke="#9db3bd" stroke-width="1"/><g class="float"><path d="M43 16h6v5h-6z" fill="#dc9d90"/><path d="M39 24h15" stroke="#7eaaad" stroke-width="2"/></g>',
 };
 return `<g class="pet action-${look.action} species-${look.species}" style="color:${color};--pet-delay:-${look.phase * .37}s" opacity="${sleeping ? ".62" : "1"}"><ellipse cx="0" cy="22" rx="19" ry="3" fill="#111820" opacity=".35"/><g class="pet-body">${ears[look.species]}<path d="M-14 -13h28v4h3v21h-4v6H5v-5H-5v5h-8v-6h-4V-9h3z" fill="currentColor"/>${look.species === "robot" ? '<path d="M-11 -9h22v12h-22z" fill="#35454f"/><path d="M-6 8H6" stroke="#c5d5d3" stroke-width="2"/>' : ''}${look.species === "bear" ? '<path d="M-6 0H6v8H-6z" fill="#d8c5ac"/><path d="M-2 2h4v3h-4" fill="#544841"/>' : ''}<path d="${eyes}" stroke="${look.species === "robot" ? "#b6e3d7" : "#20232a"}" stroke-width="3"/>${props[look.action]}</g></g>`;
}
