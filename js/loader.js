
        var Module;

        if (typeof Module === 'undefined') Module = eval(
            '(function() { try { return Module || {} } catch(e) { return {} } })()');

        if (!Module.expectedDataFileDownloads) {
            Module.expectedDataFileDownloads = 0;
            Module.finishedDataFileDownloads = 0;
        }
        Module.expectedDataFileDownloads++;
        (function () {
            var loadPackage = function (metadata) {

                var PACKAGE_PATH;
                if (typeof window === 'object') {
                    PACKAGE_PATH = window['encodeURIComponent'](window.location.pathname.toString().substring(0,
                        window.location.pathname.toString().lastIndexOf('/')) + '/');
                } else if (typeof location !== 'undefined') {
                    PACKAGE_PATH = encodeURIComponent(location.pathname.toString().substring(0, location
                        .pathname.toString().lastIndexOf('/')) + '/');
                } else {
                    throw 'using preloaded data can only be done on a web page or in a web worker';
                }

                var PACKAGE_NAME = 'game.data';
                var REMOTE_PACKAGE_BASE = 'game.data';
                if (typeof Module['locateFilePackage'] === 'function' && !Module['locateFile']) {
                    Module['locateFile'] = Module['locateFilePackage'];
                    Module.printErr(
                        'warning: you defined Module.locateFilePackage, that has been renamed to Module.locateFile (using your locateFilePackage for now)'
                        );
                }
                var REMOTE_PACKAGE_NAME = typeof Module['locateFile'] === 'function' ?
                    Module['locateFile'](REMOTE_PACKAGE_BASE) :
                    ((Module['filePackagePrefixURL'] || '') + REMOTE_PACKAGE_BASE);

                var REMOTE_PACKAGE_SIZE = metadata.remote_package_size;
                var PACKAGE_UUID = metadata.package_uuid;

                function handleError(error) {
                    console.error('package error:', error);
                }

                function runWithFS() {

                    function assert(check, msg) {
                        if (!check) throw msg + new Error().stack;
                    }

                    function DataRequest(start, end, crunched, audio) {
                        this.start = start;
                        this.end = end;
                        this.crunched = crunched;
                        this.audio = audio;
                    }
                    DataRequest.prototype = {
                        requests: {},
                        open: function (mode, name) {
                            this.name = name;
                            this.requests[name] = this;
                            Module['addRunDependency']('fp ' + this.name);
                        },
                        send: function () {},
                        onload: function () {
                            var byteArray = this.byteArray.subarray(this.start, this.end);
                            this.finish(byteArray);
                        },
                        finish: function (byteArray) {
                            var that = this;
                            Module['FS_createDataFile'](this.name, null, byteArray, true, true, true);
                            Module['removeRunDependency']('fp ' + that.name);
                            this.requests[this.name] = null;
                        }
                    };

                    var files = metadata.files;
                    for (var i = 0; i < files.length; ++i) {
                        new DataRequest(files[i].start, files[i].end, files[i].crunched, files[i].audio).open(
                            'GET', files[i].filename);
                    }

                    function processPackageData(arrayBuffer) {
                        Module.finishedDataFileDownloads++;
                        assert(arrayBuffer, 'Loading data file failed.');
                        assert(arrayBuffer instanceof ArrayBuffer, 'bad input to processPackageData');

                        var byteArray = new Uint8Array(arrayBuffer);
                        if (Module['SPLIT_MEMORY'])
                            Module.printErr('warning: SPLIT_MEMORY used, ensure --no-heap-copy flag was used');

                        var ptr = Module['getMemory'](byteArray.length);
                        Module['HEAPU8'].set(byteArray, ptr);
                        DataRequest.prototype.byteArray = Module['HEAPU8'].subarray(ptr, ptr + byteArray
                        .length);

                        for (var i = 0; i < files.length; ++i) {
                            DataRequest.prototype.requests[files[i].filename].onload();
                        }

                        Module['removeRunDependency']('datafile_game.data');
                    }

                    Module['addRunDependency']('datafile_game.data');

                    function loaddatathing(base64String) {
                        try {
                            console.info("Loading game.data from Base64...");
                            const binaryString = atob(base64String);
                            const len = binaryString.length;
                            const bytes = new Uint8Array(len);
                            for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
                            const arrayBuffer = bytes.buffer;
                            processPackageData(arrayBuffer);
                        } catch (err) {
                            console.error("Base64 load failed:", err);
                            handleError(err);
                        }
                    }

                    function fetchRemotePackage(packageName, packageSize, callback, errback) {
                        var xhr = new XMLHttpRequest();
                        xhr.open('GET', packageName, true);
                        xhr.responseType = 'arraybuffer';
                        xhr.onload = function (event) {
                            if (xhr.status == 200 || xhr.status == 304 || xhr.status == 206 || (xhr
                                    .status == 0 && xhr.response)) {
                                callback(xhr.response);
                            } else {
                                errback(new Error(xhr.statusText));
                            }
                        };
                        xhr.onerror = errback;
                        xhr.send(null);
                    }

                    if (window.gameDataBase64) {
                        loaddatathing(window.gameDataBase64);
                    } else {
                        console.info("No Base64 data found, fetching remotely...");
                        fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE, processPackageData,
                            handleError);
                    }
                }

                if (Module['calledRun']) {
                    runWithFS();
                } else {
                    if (!Module['preRun']) Module['preRun'] = [];
                    Module["preRun"].push(runWithFS);
                }
            }

            loadPackage({
                "package_uuid": "517e3f53-625a-465c-bf45-a326846f4beb",
                "remote_package_size": 10642897,
                "files": [{
                    "filename": "/game.love",
                    "crunched": 0,
                    "start": 0,
                    "end": 10642897,
                    "audio": false
                }]
            });
        })();
