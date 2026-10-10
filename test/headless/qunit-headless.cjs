/*
 * Headless runner for the jQuery QUnit browser test suite (test/index.html).
 *
 * Used by the sealed CI build (see .travis.yml / test/headless/ci-qunit.sh). Requires:
 *   - Node >= 18
 *   - puppeteer-core, resolvable via NODE_PATH (it does not download a browser)
 *   - a Chrome/Chromium binary: env CHROME_BIN (default "google-chrome")
 *   - the repository root served over HTTP with PHP (the ajax tests need
 *     test/data/*.php), e.g. `php -S 127.0.0.1:8000 -t .`
 *
 * Usage:
 *   node test/headless/qunit-headless.cjs [baseUrl]
 *
 * The base URL defaults to env QUNIT_BASE_URL or http://127.0.0.1:8000 and the
 * test page is <baseUrl>/test/index.html (env QUNIT_QUERY, e.g. "dev", is
 * appended as the query string when set). For reproducing slow-CI timing
 * locally, env QUNIT_CPU_THROTTLE=<rate> (e.g. 4) slows the page's CPU via CDP.
 *
 * Prints one line per test, the failed assertions of failing tests, per-module
 * pass counts and a final summary. While waiting it prints a heartbeat line at
 * least every 60s. Exits 1 if any test failed, if no test completed for
 * QUNIT_STALL_MS (default 2 minutes; diagnostics are printed), or if the run
 * did not complete within QUNIT_TIMEOUT_MS (default 15 minutes).
 */
"use strict";

var puppeteer = require( "puppeteer-core" );

var baseUrl = ( process.argv[ 2 ] || process.env.QUNIT_BASE_URL ||
		"http://127.0.0.1:8000" ).replace( /\/+$/, "" ),
	query = process.env.QUNIT_QUERY ? "?" + process.env.QUNIT_QUERY : "",
	testUrl = baseUrl + "/test/index.html" + query,
	chromeBin = process.env.CHROME_BIN || "google-chrome",
	overallTimeoutMs = parseInt( process.env.QUNIT_TIMEOUT_MS, 10 ) || 15 * 60 * 1000,
	cpuThrottle = parseFloat( process.env.QUNIT_CPU_THROTTLE ) || 0,
	stallTimeoutMs = parseInt( process.env.QUNIT_STALL_MS, 10 ) || 2 * 60 * 1000,
	heartbeatMs = 60 * 1000,
	pollIntervalMs = 1000,

	// A single in-page evaluate must not block the watchdog
	evaluateTimeoutMs = 20 * 1000,

	// Time with no new test activity after QUnit.done before declaring the run finished
	settleMs = 3000;

// Runs in the page (top frame only) before any page script: hooks QUnit's
// logging callbacks the moment qunit.js assigns window.QUnit, and holds back
// the suite's initial QUnit.start() until the window "load" event has fired.
//
// Why the latter: qunit.js registers QUnit.load as a window "load" handler, and
// test/data/testinit.js also calls QUnit.load() + QUnit.start() itself once the
// test modules are loaded. QUnit.load() runs QUnit.init(), which rebuilds the
// #qunit DOM (including #qunit-tests). In a normal browser "load" fires before
// the suite starts, but when page subresources are slow (e.g. a loaded CI VM)
// "load" can fire while a test is running: the running test's <li> is wiped,
// Test.finish throws "Cannot set properties of null (setting 'className')" and
// QUnit's queue stops for good. Starting only after "load" makes this
// deterministic without changing any test.
function installHooks() {
	if ( window !== window.top ) {
		return;
	}

	var state = window.__qunitHeadless = {
		tests: [],
		current: null,
		doneCount: 0,
		doneDetails: null,
		lastActivity: Date.now(),
		windowLoaded: false,
		deferredStarts: 0,
		errors: []
	};
	var hooked = false;
	var qunitRef;
	var pendingStarts = [];

	window.addEventListener( "load", function() {
		// Let QUnit's own "load" handler (registered earlier by qunit.js) run first
		setTimeout( function() {
			state.windowLoaded = true;
			var calls = pendingStarts;
			pendingStarts = [];
			calls.forEach( function( call ) {
				call.fn.apply( call.self, call.args );
			} );
		}, 0 );
	} );

	// Snapshot of QUnit's state, used for heartbeat and stall diagnostics
	window.__qunitHeadlessDiag = function() {
		var Q = qunitRef,
			config = Q && Q.config,
			current = config && config.current,
			testsEl = document.getElementById( "qunit-tests" );
		return {
			readyState: document.readyState,
			windowLoaded: state.windowLoaded,
			deferredStarts: state.deferredStarts,
			testsDone: state.tests.length,
			currentTest: current ? ( current.module + " :: " + current.testName ) : null,
			queueLength: config && config.queue ? config.queue.length : null,
			semaphore: config ? config.semaphore : null,
			blocking: config ? config.blocking : null,
			depth: config ? config.depth : null,
			qunitTestsChildren: testsEl ? testsEl.children.length : null,
			resultText: ( document.getElementById( "qunit-testresult" ) || {} ).textContent || ""
		};
	};

	window.addEventListener( "error", function( e ) {
		state.errors.push( String( e.message ) + " @ " + e.filename + ":" + e.lineno );
	} );

	function stringify( value ) {
		try {
			if ( typeof value === "string" ) {
				return JSON.stringify( value );
			}
			var json = JSON.stringify( value );
			return json === undefined ? String( value ) : json;
		} catch ( e ) {
			return String( value );
		}
	}

	function hook( Q ) {
		if ( hooked || !Q || typeof Q.testDone !== "function" ) {
			return;
		}
		hooked = true;

		var originalStart = Q.start;
		Q.start = function() {
			if ( state.windowLoaded ) {
				return originalStart.apply( this, arguments );
			}
			state.deferredStarts++;
			pendingStarts.push( { fn: originalStart, self: this, args: arguments } );
		};

		Q.testStart( function( details ) {
			state.current = { module: details.module, name: details.name, failures: [] };
			state.lastActivity = Date.now();
		} );

		Q.log( function( details ) {
			state.lastActivity = Date.now();
			if ( details.result ) {
				return;
			}
			var msg = details.message || "(no message)";
			if ( details.hasOwnProperty( "expected" ) ) {
				msg += " | expected: " + stringify( details.expected ) +
					" | actual: " + stringify( details.actual );
			}
			if ( details.source ) {
				msg += " | source: " + String( details.source ).split( "\n" )[ 0 ].trim();
			}
			if ( state.current ) {
				state.current.failures.push( msg );
			} else {
				state.errors.push( "Assertion outside of a test: " + msg );
			}
		} );

		Q.testDone( function( details ) {
			var cur = state.current || { failures: [] };
			state.tests.push( {
				module: details.module,
				name: details.name,
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime,
				failures: cur.failures
			} );
			state.current = null;
			state.lastActivity = Date.now();
		} );

		Q.done( function( details ) {
			state.doneCount++;
			state.doneDetails = {
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime
			};
			state.lastActivity = Date.now();
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( value ) {
			qunitRef = value;
			hook( value );
		}
	} );
}

function sleep( ms ) {
	return new Promise( function( resolve ) {
		setTimeout( resolve, ms );
	} );
}

function printTest( t ) {
	var ok = t.failed === 0;
	console.log( ( ok ? "PASS " : "FAIL " ) + t.module + " :: " + t.name +
		" (" + t.passed + "/" + t.total + " assertions)" );
	if ( !ok ) {
		t.failures.forEach( function( f ) {
			console.log( "    - " + f );
		} );
	}
}

function withTimeout( promise, ms, what ) {
	var timer;
	return Promise.race( [
		promise,
		new Promise( function( resolve, reject ) {
			timer = setTimeout( function() {
				reject( new Error( what + " did not answer within " + ms + "ms" ) );
			}, ms );
		} )
	] ).finally( function() {
		clearTimeout( timer );
	} );
}

function diagnose( page ) {
	return withTimeout( page.evaluate( function() {
		return window.__qunitHeadlessDiag ? window.__qunitHeadlessDiag() : null;
	} ), evaluateTimeoutMs, "page" ).catch( function( err ) {
		return { error: String( err && err.message || err ) };
	} );
}

function seconds( ms ) {
	return Math.round( ms / 1000 ) + "s";
}

async function main() {
	var browser, page, state, diag, printed = 0, timedOut = false, stalled = false,
		finished = false, crashed = null,
		startedAt = Date.now(),
		deadline = startedAt + overallTimeoutMs,
		lastProgressAt = startedAt,
		lastOutputAt = startedAt;

	function log( line ) {
		lastOutputAt = Date.now();
		console.log( line );
	}

	log( "QUnit headless runner: " + testUrl + " (chrome: " + chromeBin + ")" );

	browser = await puppeteer.launch( {
		executablePath: chromeBin,
		headless: false,
		args: [
			"--no-sandbox",
			"--headless=new",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--window-size=1280,1024"
		],
		defaultViewport: { width: 1280, height: 1024 },
		protocolTimeout: overallTimeoutMs + 60000
	} );

	try {
		page = await browser.newPage();
		page.on( "error", function( err ) {
			crashed = err;
		} );
		page.on( "dialog", function( dialog ) {
			dialog.dismiss().catch( function() {} );
		} );

		if ( cpuThrottle > 1 ) {
			log( "Emulating CPU throttling: " + cpuThrottle + "x slowdown" );
			await page.emulateCPUThrottling( cpuThrottle );
		}
		await page.evaluateOnNewDocument( installHooks );
		await page.goto( testUrl, { waitUntil: "domcontentloaded", timeout: 120000 } );

		while ( !finished ) {
			if ( crashed ) {
				throw crashed;
			}
			if ( Date.now() > deadline ) {
				timedOut = true;
				break;
			}
			await sleep( pollIntervalMs );

			try {
				state = await withTimeout( page.evaluate( function( from ) {
					var s = window.__qunitHeadless,
						result = document.getElementById( "qunit-testresult" );
					if ( !s ) {
						return null;
					}
					return {
						tests: s.tests.slice( from ),
						doneCount: s.doneCount,
						doneDetails: s.doneDetails,
						idleMs: Date.now() - s.lastActivity,
						resultText: result ? result.textContent : "",
						running: !!s.current,
						errors: s.errors.splice( 0, s.errors.length )
					};
				}, printed ), evaluateTimeoutMs, "page" );
			} catch ( err ) {
				log( "[runner] could not query the page: " + ( err && err.message || err ) );
				state = null;
			}

			if ( state ) {
				state.errors.forEach( function( e ) {
					log( "[page error] " + e );
				} );
				state.tests.forEach( function( t ) {
					lastOutputAt = Date.now();
					printTest( t );
				} );
				if ( state.tests.length ) {
					printed += state.tests.length;
					lastProgressAt = Date.now();
				}

				if ( state.doneCount > 0 && printed > 0 && !state.running &&
						state.idleMs >= settleMs && /completed/.test( state.resultText ) ) {
					finished = true;
					break;
				}
			}

			// Stall watchdog: QUnit's own per-test timeout is 20s, so a long
			// silence means its queue has died; fail fast with diagnostics.
			if ( Date.now() - lastProgressAt >= stallTimeoutMs ) {
				stalled = true;
				diag = await diagnose( page );
				log( "ERROR: no QUnit test completed in the last " + seconds( stallTimeoutMs ) +
					"; aborting. Diagnostics: " + JSON.stringify( diag ) );
				break;
			}

			if ( Date.now() - lastOutputAt >= heartbeatMs ) {
				diag = await diagnose( page );
				log( "[heartbeat] " + seconds( Date.now() - startedAt ) + " elapsed, " +
					printed + " tests done, current test: " +
					( diag && diag.currentTest || "(none)" ) +
					", last test completed " + seconds( Date.now() - lastProgressAt ) + " ago" );
			}
		}

		if ( timedOut ) {
			diag = await diagnose( page );
			log( "Diagnostics at timeout: " + JSON.stringify( diag ) );
		}

		return {
			tests: await withTimeout( page.evaluate( function() {
				return window.__qunitHeadless ? window.__qunitHeadless.tests : [];
			} ), evaluateTimeoutMs, "page" ).catch( function() {
				return null;
			} ) || [],
			timedOut: timedOut,
			stalled: stalled,
			doneDetails: state && state.doneDetails
		};
	} finally {
		await browser.close().catch( function() {} );
	}
}

main().then( function( res ) {
	var modules = {}, moduleOrder = [],
		passedTests = 0, failedTests = 0, aPassed = 0, aFailed = 0;

	res.tests.forEach( function( t ) {
		var m = modules[ t.module ];
		if ( !m ) {
			m = modules[ t.module ] = { passed: 0, failed: 0 };
			moduleOrder.push( t.module );
		}
		if ( t.failed === 0 ) {
			passedTests++;
			m.passed++;
		} else {
			failedTests++;
			m.failed++;
		}
		aPassed += t.passed;
		aFailed += t.failed;
	} );

	console.log( "" );
	console.log( "Per-module results:" );
	moduleOrder.forEach( function( name ) {
		var m = modules[ name ];
		console.log( "  " + name + ": " + m.passed + "/" + ( m.passed + m.failed ) +
			" tests passed" + ( m.failed ? " (" + m.failed + " failed)" : "" ) );
	} );

	if ( res.tests.length ) {
		var failedList = res.tests.filter( function( t ) {
			return t.failed !== 0;
		} );
		if ( failedList.length ) {
			console.log( "" );
			console.log( "Failed tests:" );
			failedList.forEach( function( t ) {
				console.log( "  " + t.module + " :: " + t.name );
			} );
		}
	}

	console.log( "" );
	if ( res.doneDetails ) {
		console.log( "QUnit reported: " + res.doneDetails.passed + " assertions passed, " +
			res.doneDetails.failed + " failed, " + res.doneDetails.total + " total in " +
			res.doneDetails.runtime + "ms" );
	}
	if ( res.timedOut ) {
		console.log( "ERROR: QUnit run did not complete within " + overallTimeoutMs + "ms" );
	}
	if ( res.stalled ) {
		console.log( "ERROR: QUnit run stalled (no test completed for " + stallTimeoutMs + "ms)" );
	}
	console.log( "QUnit summary: " + passedTests + " tests passed, " + failedTests +
		" tests failed, " + res.tests.length + " total; assertions " + aPassed +
		" passed / " + aFailed + " failed" );

	process.exit( failedTests > 0 || res.timedOut || res.stalled || res.tests.length === 0 ? 1 : 0 );
}, function( err ) {
	console.error( "ERROR: QUnit headless run aborted: " + ( err && err.stack || err ) );
	process.exit( 1 );
} );
