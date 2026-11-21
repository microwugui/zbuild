function f() {
  let a = 1, b;
  {
    const c = 2;
  }
  if (a) {
    var d = null;
  }
  for (let i = 0; i < 1; i++) {
    let e = i;
  }
  return b;
}
f();
