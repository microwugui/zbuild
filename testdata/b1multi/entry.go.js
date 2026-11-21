// testdata/b1multi/dep.js
var Foo = class _Foo {
  constructor(x = _Foo.D) {
    this.x = x;
  }
  static make() {
    return new _Foo();
  }
};
Foo.D = 42;
var tag = "dep";

// testdata/b1multi/entry.js
var made = Foo.make();
export {
  Foo,
  made,
  tag
};
/** @license MIT */
