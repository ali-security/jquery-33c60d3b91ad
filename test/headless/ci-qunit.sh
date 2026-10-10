#!/usr/bin/env bash
#
# Runs the QUnit browser test suite (test/index.html) headlessly in Chrome.
# Used by the sealed CI build (.travis.yml); /test is not part of the npm package.
#
# 1. serves the repository root with PHP's built-in server (the ajax tests need
#    test/data/*.php),
# 2. installs puppeteer-core into a separate directory from the public npm
#    registry (independent of any registry configured for the project itself),
# 3. runs test/headless/qunit-headless.cjs with the `node` found on PATH (must be >= 18)
#    and exits with its exit code.
#
# Environment:
#   CHROME_BIN              Chrome binary (default: google-chrome on PATH)
#   QUNIT_PORT              port for the PHP server (default: 8000)
#   QUNIT_RUNNER_DIR        where puppeteer-core is installed (default: /tmp/qunit-runner)
#   PUPPETEER_CORE_VERSION  puppeteer-core version (default: 22.15.0)
#   PHP_SERVER_LOG          PHP server log file (default: /tmp/php-server.log)

set -u

cd "$( dirname "$0" )/../.." || exit 1

port="${QUNIT_PORT:-8000}"
runner_dir="${QUNIT_RUNNER_DIR:-/tmp/qunit-runner}"
puppeteer_version="${PUPPETEER_CORE_VERSION:-22.15.0}"
php_log="${PHP_SERVER_LOG:-/tmp/php-server.log}"
chrome_bin="${CHROME_BIN:-$( command -v google-chrome || echo google-chrome )}"

echo "node: $( command -v node ) $( node --version )"
echo "chrome: ${chrome_bin} $( "${chrome_bin}" --version 2>/dev/null )"
echo "php: $( command -v php ) $( php -r 'echo PHP_VERSION;' )"

# Several workers: test/data/core/dont_return.php sleeps 30s on purpose, which
# would otherwise block the single-threaded built-in server for other requests.
# PHP notices/warnings go to the log instead of into response bodies.
PHP_CLI_SERVER_WORKERS=4 php -d display_errors=stderr -S "127.0.0.1:${port}" -t . \
	> "${php_log}" 2>&1 &
php_pid=$!

cleanup() {
	pkill -P "${php_pid}" 2>/dev/null
	kill "${php_pid}" 2>/dev/null
}
trap cleanup EXIT

for i in $( seq 1 30 ); do
	if curl -sf -o /dev/null "http://127.0.0.1:${port}/test/index.html"; then
		break
	fi
	if [ "${i}" = 30 ]; then
		echo "ERROR: PHP server did not come up on port ${port}"
		cat "${php_log}"
		exit 1
	fi
	sleep 1
done

mkdir -p "${runner_dir}"
: > "${runner_dir}/.npmrc"
[ -f "${runner_dir}/package.json" ] || echo '{ "private": true }' > "${runner_dir}/package.json"
( cd "${runner_dir}" && npm install --no-save --no-package-lock --no-audit --no-fund \
	--userconfig "${runner_dir}/.npmrc" \
	--registry=https://registry.npmjs.org/ \
	"puppeteer-core@${puppeteer_version}" ) || {
	echo "ERROR: failed to install puppeteer-core@${puppeteer_version}"
	exit 1
}

CHROME_BIN="${chrome_bin}" NODE_PATH="${runner_dir}/node_modules" \
	node test/headless/qunit-headless.cjs "http://127.0.0.1:${port}"
status=$?

if [ "${status}" != 0 ]; then
	echo "---- last 60 lines of the PHP server log (${php_log}) ----"
	tail -n 60 "${php_log}"
fi
echo "QUnit headless runner exit code: ${status}"
exit "${status}"
