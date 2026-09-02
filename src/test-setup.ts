// jsdom ne connaît pas le défilement : le journal qui suit sa dernière ligne
// n'a rien à faire ici, mais son absence ne doit pas faire tomber un test.
Element.prototype.scrollIntoView = () => {};
