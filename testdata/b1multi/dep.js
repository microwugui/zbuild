/** @license MIT */
export class Foo {
  constructor(x = Foo.D) { this.x = x; }
  static make() { return new Foo(); }
}
Foo.D = 42;
export const tag = "dep";
