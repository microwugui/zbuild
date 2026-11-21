class A {
  static #p = 1;
  #q = 2;
  static {
    this.x = A.#p;
  }
  [key] = 3;
  get #g() {
    return this.#q;
  }
  #m() {
    return 1;
  }
  static #sm() {
    return 2;
  }
  @dec method() {}
  static s = this;
}
class B extends A {
  constructor() {
    super();
  }
  #x;
}
export default class {
  static y = this;
}
