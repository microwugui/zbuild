import a, { b as c, d } from "p1";
import * as ns from "p2";
import "p3";
let x = 0, w = 0;
function y() {}
export { x, y as z };
export { w } from "p4";
export * from "p5";
export * as ns2 from "p6";
export default function f() {}
export function g() {}
export class K {}
export let q = 1;
