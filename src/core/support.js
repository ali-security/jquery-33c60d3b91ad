define([
	"../var/support"
], function( support ) {

// Support: IE<9
// document.implementation.createHTMLDocument is not available
// Support: Safari 8
// Sibling forms parsed into a document created with createHTMLDocument
// get nested, so it can't be used for jQuery.parseHTML there
support.createHTMLDocument = (function() {
	if ( !document.implementation.createHTMLDocument ) {
		return false;
	}
	var doc = document.implementation.createHTMLDocument( "" );
	doc.body.innerHTML = "<form></form><form></form>";
	return doc.body.childNodes.length === 2;
})();

return support;
});
