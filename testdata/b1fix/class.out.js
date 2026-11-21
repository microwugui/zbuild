// testdata/b1fix/class.js
var Foo = class _Foo {
  constructor(x = _Foo.DEFAULT) {
    this.x = x;
  }
  static make() {
    return new _Foo();
  }
};
Foo.DEFAULT = 42;
export {
  Foo
};
