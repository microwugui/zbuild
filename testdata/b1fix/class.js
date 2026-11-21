class Foo {
  constructor(x = Foo.DEFAULT) { this.x = x; }
  static make() { return new Foo(); }
}
Foo.DEFAULT = 42;
export { Foo };
