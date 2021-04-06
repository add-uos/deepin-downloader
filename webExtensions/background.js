// Copyright (c) 2013 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var QWebChannelMessageTypes = {
    signal: 1,
    propertyUpdate: 2,
    init: 3,
    idle: 4,
    debug: 5,
    invokeMethod: 6,
    connectToSignal: 7,
    disconnectFromSignal: 8,
    setProperty: 9,
    response: 10,
};

var QWebChannel = function(transport, initCallback)
{
    if (typeof transport !== "object" || typeof transport.send !== "function") {
        console.error("The QWebChannel expects a transport object with a send function and onmessage callback property." +
                      " Given is: transport: " + typeof(transport) + ", transport.send: " + typeof(transport.send));
        return;
    }

    var channel = this;
    this.transport = transport;

    this.send = function(data)
    {
        if (typeof(data) !== "string") {
            data = JSON.stringify(data);
        }
        channel.transport.send(data);
    }

    this.transport.onmessage = function(message)
    {
        var data = message.data;
        if (typeof data === "string") {
            data = JSON.parse(data);
        }
        switch (data.type) {
            case QWebChannelMessageTypes.signal:
                channel.handleSignal(data);
                break;
            case QWebChannelMessageTypes.response:
                channel.handleResponse(data);
                break;
            case QWebChannelMessageTypes.propertyUpdate:
                channel.handlePropertyUpdate(data);
                break;
            default:
                console.error("invalid message received:", message.data);
                break;
        }
    }

    this.execCallbacks = {};
    this.execId = 0;
    this.exec = function(data, callback)
    {
        if (!callback) {
            // if no callback is given, send directly
            channel.send(data);
            return;
        }
        if (channel.execId === Number.MAX_VALUE) {
            // wrap
            channel.execId = Number.MIN_VALUE;
        }
        if (data.hasOwnProperty("id")) {
            console.error("Cannot exec message with property id: " + JSON.stringify(data));
            return;
        }
        data.id = channel.execId++;
        channel.execCallbacks[data.id] = callback;
        channel.send(data);
    };

    this.objects = {};

    this.handleSignal = function(message)
    {
        var object = channel.objects[message.object];
        if (object) {
            object.signalEmitted(message.signal, message.args);
        } else {
            console.warn("Unhandled signal: " + message.object + "::" + message.signal);
        }
    }

    this.handleResponse = function(message)
    {
        if (!message.hasOwnProperty("id")) {
            console.error("Invalid response message received: ", JSON.stringify(message));
            return;
        }
        channel.execCallbacks[message.id](message.data);
        delete channel.execCallbacks[message.id];
    }

    this.handlePropertyUpdate = function(message)
    {
        for (var i in message.data) {
            var data = message.data[i];
            var object = channel.objects[data.object];
            if (object) {
                object.propertyUpdate(data.signals, data.properties);
            } else {
                console.warn("Unhandled property update: " + data.object + "::" + data.signal);
            }
        }
        channel.exec({type: QWebChannelMessageTypes.idle});
    }

    this.debug = function(message)
    {
        channel.send({type: QWebChannelMessageTypes.debug, data: message});
    };

    channel.exec({type: QWebChannelMessageTypes.init}, function(data) {
        for (var objectName in data) {
            var object = new QObject(objectName, data[objectName], channel);
        }
        // now unwrap properties, which might reference other registered objects
        for (var objectName in channel.objects) {
            channel.objects[objectName].unwrapProperties();
        }
        if (initCallback) {
            initCallback(channel);
        }
        channel.exec({type: QWebChannelMessageTypes.idle});
    });
};

function QObject(name, data, webChannel)
{
    this.__id__ = name;
    webChannel.objects[name] = this;

    // List of callbacks that get invoked upon signal emission
    this.__objectSignals__ = {};

    // Cache of all properties, updated when a notify signal is emitted
    this.__propertyCache__ = {};

    var object = this;

    // ----------------------------------------------------------------------

    this.unwrapQObject = function(response)
    {
        if (response instanceof Array) {
            // support list of objects
            var ret = new Array(response.length);
            for (var i = 0; i < response.length; ++i) {
                ret[i] = object.unwrapQObject(response[i]);
            }
            return ret;
        }
        if (!response
            || !response["__QObject*__"]
            || response.id === undefined) {
            return response;
        }

        var objectId = response.id;
        if (webChannel.objects[objectId])
            return webChannel.objects[objectId];

        if (!response.data) {
            console.error("Cannot unwrap unknown QObject " + objectId + " without data.");
            return;
        }

        var qObject = new QObject( objectId, response.data, webChannel );
        qObject.destroyed.connect(function() {
            if (webChannel.objects[objectId] === qObject) {
                delete webChannel.objects[objectId];
                // reset the now deleted QObject to an empty {} object
                // just assigning {} though would not have the desired effect, but the
                // below also ensures all external references will see the empty map
                // NOTE: this detour is necessary to workaround QTBUG-40021
                var propertyNames = [];
                for (var propertyName in qObject) {
                    propertyNames.push(propertyName);
                }
                for (var idx in propertyNames) {
                    delete qObject[propertyNames[idx]];
                }
            }
        });
        // here we are already initialized, and thus must directly unwrap the properties
        qObject.unwrapProperties();
        return qObject;
    }

    this.unwrapProperties = function()
    {
        for (var propertyIdx in object.__propertyCache__) {
            object.__propertyCache__[propertyIdx] = object.unwrapQObject(object.__propertyCache__[propertyIdx]);
        }
    }

    function addSignal(signalData, isPropertyNotifySignal)
    {
        var signalName = signalData[0];
        var signalIndex = signalData[1];
        object[signalName] = {
            connect: function(callback) {
                if (typeof(callback) !== "function") {
                    console.error("Bad callback given to connect to signal " + signalName);
                    return;
                }

                object.__objectSignals__[signalIndex] = object.__objectSignals__[signalIndex] || [];
                object.__objectSignals__[signalIndex].push(callback);

                if (!isPropertyNotifySignal && signalName !== "destroyed") {
                    // only required for "pure" signals, handled separately for properties in propertyUpdate
                    // also note that we always get notified about the destroyed signal
                    webChannel.exec({
                        type: QWebChannelMessageTypes.connectToSignal,
                        object: object.__id__,
                        signal: signalIndex
                    });
                }
            },
            disconnect: function(callback) {
                if (typeof(callback) !== "function") {
                    console.error("Bad callback given to disconnect from signal " + signalName);
                    return;
                }
                object.__objectSignals__[signalIndex] = object.__objectSignals__[signalIndex] || [];
                var idx = object.__objectSignals__[signalIndex].indexOf(callback);
                if (idx === -1) {
                    console.error("Cannot find connection of signal " + signalName + " to " + callback.name);
                    return;
                }
                object.__objectSignals__[signalIndex].splice(idx, 1);
                if (!isPropertyNotifySignal && object.__objectSignals__[signalIndex].length === 0) {
                    // only required for "pure" signals, handled separately for properties in propertyUpdate
                    webChannel.exec({
                        type: QWebChannelMessageTypes.disconnectFromSignal,
                        object: object.__id__,
                        signal: signalIndex
                    });
                }
            }
        };
    }

    /**
     * Invokes all callbacks for the given signalname. Also works for property notify callbacks.
     */
    function invokeSignalCallbacks(signalName, signalArgs)
    {
        var connections = object.__objectSignals__[signalName];
        if (connections) {
            connections.forEach(function(callback) {
                callback.apply(callback, signalArgs);
            });
        }
    }

    this.propertyUpdate = function(signals, propertyMap)
    {
        // update property cache
        for (var propertyIndex in propertyMap) {
            var propertyValue = propertyMap[propertyIndex];
            object.__propertyCache__[propertyIndex] = propertyValue;
        }

        for (var signalName in signals) {
            // Invoke all callbacks, as signalEmitted() does not. This ensures the
            // property cache is updated before the callbacks are invoked.
            invokeSignalCallbacks(signalName, signals[signalName]);
        }
    }

    this.signalEmitted = function(signalName, signalArgs)
    {
        invokeSignalCallbacks(signalName, this.unwrapQObject(signalArgs));
    }

    function addMethod(methodData)
    {
        var methodName = methodData[0];
        var methodIdx = methodData[1];
        object[methodName] = function() {
            var args = [];
            var callback;
            for (var i = 0; i < arguments.length; ++i) {
                var argument = arguments[i];
                if (typeof argument === "function")
                    callback = argument;
                else if (argument instanceof QObject && webChannel.objects[argument.__id__] !== undefined)
                    args.push({
                        "id": argument.__id__
                    });
                else
                    args.push(argument);
            }

            webChannel.exec({
                "type": QWebChannelMessageTypes.invokeMethod,
                "object": object.__id__,
                "method": methodIdx,
                "args": args
            }, function(response) {
                if (response !== undefined) {
                    var result = object.unwrapQObject(response);
                    if (callback) {
                        (callback)(result);
                    }
                }
            });
        };
    }

    function bindGetterSetter(propertyInfo)
    {
        var propertyIndex = propertyInfo[0];
        var propertyName = propertyInfo[1];
        var notifySignalData = propertyInfo[2];
        // initialize property cache with current value
        // NOTE: if this is an object, it is not directly unwrapped as it might
        // reference other QObject that we do not know yet
        object.__propertyCache__[propertyIndex] = propertyInfo[3];

        if (notifySignalData) {
            if (notifySignalData[0] === 1) {
                // signal name is optimized away, reconstruct the actual name
                notifySignalData[0] = propertyName + "Changed";
            }
            addSignal(notifySignalData, true);
        }

        Object.defineProperty(object, propertyName, {
            configurable: true,
            get: function () {
                var propertyValue = object.__propertyCache__[propertyIndex];
                if (propertyValue === undefined) {
                    // This shouldn't happen
                    console.warn("Undefined value in property cache for property \"" + propertyName + "\" in object " + object.__id__);
                }

                return propertyValue;
            },
            set: function(value) {
                if (value === undefined) {
                    console.warn("Property setter for " + propertyName + " called with undefined value!");
                    return;
                }
                object.__propertyCache__[propertyIndex] = value;
                var valueToSend = value;
                if (valueToSend instanceof QObject && webChannel.objects[valueToSend.__id__] !== undefined)
                    valueToSend = { "id": valueToSend.__id__ };
                webChannel.exec({
                    "type": QWebChannelMessageTypes.setProperty,
                    "object": object.__id__,
                    "property": propertyIndex,
                    "value": valueToSend
                });
            }
        });

    }



    data.methods.forEach(addMethod);

    data.properties.forEach(bindGetterSetter);

    data.signals.forEach(function(signal) { addSignal(signal, false); });

    for (var name in data.enums) {
        object[name] = data.enums[name];
    }
}

//required for use with nodejs
if (typeof module === 'object') {
    module.exports = {
        QWebChannel: QWebChannel
    };
}

// ----------------------------------------------------------------------

var socket;
var webChanel;
var downloadFlag = false;
var downloadItem;
var downloadId;
var socketIsOpen = false;
var downloadTable;
var isSelfCreate = false;

function main() {
    console.log("main")
    var date = new Date();
    console.log(date);
    socket  = new WebSocket("ws://localhost:12345");

    socket.onopen = function() {
        onSocketOpen();
    }
    socket.onerror = function() {
        console.log("websocket error")
    }
    socket.onclose = function() {
        socketIsOpen = false;
        console.log("websocket close")
    }

    addContextMenu ("downloader", "使用下载器下载");


    chrome.tabs.onCreated.addListener(function(item) {
        console.log("chrome.tabs.onCreated")
        console.log(item)
    })

    chrome.downloads.setShelfEnabled(false);

    chrome.downloads.onDeterminingFilename.addListener(function(item) {
        console.log("onDeterminingFilename")
        console.log(item.url)
    })

    chrome.downloads.onCreated.addListener(function(item) {
        if(!isSelfCreate) {
            console.log("button Created")
            console.log(item.url)
            chrome.downloads.cancel(item.id),
            chrome.downloads.erase({
                id: item.id
            }, function(item) {}),
            item.url !== item.referrer && ("about:blank" === item.url ? chrome.tabs.getSelected(null, function(tab) {
                downloadTable = tab
                console.log("tab:")
                console.log(tab)
                tab && "" === tab.url && chrome.tabs.remove(tab.id)
                console.log("chrome.tabs.remove")
            }) : "" !== item.referrer && chrome.tabs.query({
                url: item.url
            }, function(item) {
                console.log("tab:")
                console.log(item)
                item && item[0] && chrome.tabs.remove(item[0].id)
            }))
            downloadFlag = false;
            setTimeout(()=>{
                onItemCreated(item);
            }, 0);
            
        } else {
            isSelfCreate = false
            console.log("self Created")
        }
      });

    //chrome.downloads.onChanged.addListener(onChanged);


    chrome.webRequest.onHeadersReceived.addListener(function(t) {
        return onHeadersReceived(t)
    }, {
        urls: ["<all_urls>"]
    }, ["blocking", "responseHeaders"])
    chrome.webRequest.onBeforeSendHeaders.addListener(function(t) {
        return onBeforeSendHeaders(t)
    }, {
        urls: ["<all_urls>"]
    }, ["blocking", "requestHeaders"])

    chrome.contextMenus.onClicked.addListener(onContextMenuClicked)
}

main();

function onItemCreated(item) {
    if(item.state != "in_progress") {  //判断状态不是刚创建的任务，就返回
        return;
    }
    console.log("onItemCreated")
    downloadItem = item;
    if(downloadFlag == true){
        console.log("downloadFlag true")
        downloadFlag = false;
        //chrome.downloads.setShelfEnabled(false);
        return;
    }
    if(!socketIsOpen){
        //socketIsOpen = true;
        console.log("socket not ready")
        window.open("downloader:");
        setTimeout(reConnect, 1500);
        return;
    }
    console.log("onItemCreated send text to client")
    webChanel.objects.core.receiveText(item.url);
}

function reConnect() {
    if(socketIsOpen) {
        return
    }
    console.log("reConnect")
    socket  = new WebSocket("ws://localhost:12345");
    socket.onopen = function() {
        socketIsOpen = true;
        onSocketOpen();
    }
    setTimeout(()=>{
        console.log("reConnect send text to client")
        webChanel.objects.core.receiveText(downloadItem.url);
    }, 100);

    socket.onerror = function() {
        console.log("websocket error")
        downloadFlag = true;
        chrome.downloads.setShelfEnabled(true);
        chrome.downloads.download({
            url: downloadItem.url
        }, onDownload);
        isSelfCreate = true
    }
    socket.onclose = function(){
        socketIsOpen = false;
        console.log("websocket close")
    }
}

function onSocketOpen() {
    socketIsOpen = true;
    console.log("websocket Open")
    new QWebChannel(socket, function(channel) {
        console.log("QWebChannel new")
        webChanel = channel;
        socketIsOpen = true;
        channel.objects.core.sendText.connect(function(message) {
            console.log("message :" + message)
            if(message == "0"){
                chrome.downloads.setShelfEnabled(true);
                downloadFlag = true;
                chrome.downloads.download({
                    url: downloadItem.url
                }, onDownload);
                isSelfCreate = true
                console.log("self download")
                if(downloadTable) {
                    chrome.tab.create(downloadTable)
                }
            } else {
                chrome.downloads.setShelfEnabled(false);
            }
        })
    })
}



function onChanged(downloadDelta) {
    console.log("onChanged :  " + downloadDelta.url)
    if("undefined" !=  downloadDelta.id && downloadId != downloadDelta.id) {
        console.log("cancle and erase");
        console.log("downloadDelta.state: ");
        console.log(downloadDelta.state);
        console.log("downloadDelta.id: ");
        console.log(downloadDelta.id);
        chrome.downloads.setShelfEnabled(true);
        chrome.downloads.cancel(downloadDelta.id);
        chrome.downloads.erase({id: downloadDelta.id});
        console.log("cancle and erase finish");
    }
}

function onDownload(id) {
    console.log("onDownload")
    downloadId = id;
}

function addContextMenu (id, title) {
    chrome.contextMenus.create({
        id: id,
        title: title,
        contexts: ['link']
    })
}

function onContextMenuClicked(info, tab) {
    console.log("onContextMenuClicked")
    window.open("downloader:");
    setTimeout(()=>{onTimeout(info)}, 1500);
}

function onTimeout(info) {

    console.log("setTimeout")
    var soc  = new WebSocket("ws://localhost:12345");
    soc.onopen = function() {
        new QWebChannel(soc, function(chan) {
            chan.objects.core.receiveText(info.linkUrl);
            //soc.close()
        })
    }
}

function onHeadersReceived(e) {
    console.log("onHeadersReceived")
    console.log(e.url)
    do {
        var t = e.statusCode;
        if (t >= 300 && t < 400 && 304 !== t)
            break;
        if (0 === e.statusLine.indexOf("HTTP/1.1 204 Intercepted by the Xunlei Advanced Integration"))
            break;
        var i = e.type;
        if (!this.isSupportRequestType(i))
            break;
        var n = e.url
          , o = this.requestItems[e.requestId];
        o ? delete this.requestItems[e.requestId] : (o = new l).tabId = e.tabId;
        for (var r = 0; r < e.responseHeaders.length; ++r) {
            var s = e.responseHeaders[r].name.toLowerCase()
              , a = e.responseHeaders[r].value;
            switch (s) {
            case "referer":
                o.headers.referer = a;
                break;
            case "set-cookie":
                0 === o.headers.cookie.length ? o.headers.cookie = a : o.headers.cookie = o.headers.cookie + "; " + a;
                break;
            case "access-control-allow-origin":
                originHender = "Origin: " + a;
                break;
            case "host":
                o.headers.host = a;
                break;
            case "content-disposition":
                o.headers["content-disposition"] = a;
                break;
            case "content-length":
                o.headers["content-length"] = a;
                break;
            case "content-type":
                o.headers["content-type"] = a
            }
        }
        if (0 === n.length && (n = host),
        o.url = n,
        !isFrameRequestType(i)) {
            0 === o.fileName.length && (o.fileName = getUrlFileName(o.url));
            var c = getFileNameExt(o.fileName);
            if (0 === c.length) {
                var u = getUrlFileName(o.url);
                c = getFileNameExt(u)
            }
            var h = o.headers["content-type"];
            if (0 === h.length && !isSupportMediaExt(c))
                break;
            if (parseInt(o.headers["content-length"]) < 2052 || "swf" === c)
                break;
            if (isSupportContentType(h))
                break;
            break
        }
        if (!isValidDownload(o))
            break;
        if (2 !== Math.round(e.statusCode / 100) && "other" === i)
            break;
        this.blockDownload = !0,
        o.headers.referer && o.headers.cookie ? downloadByThunder(e.tabId, o) : chrome.tabs.get(e.tabId, t=>{
            var i = t.openerTabId;
            o.headers.cookie ? downloadByThunder(e.tabId, o, i) : chrome.cookies.getAll({
                url: o.url
            }, t=>{
                var n = "";
                if (t)
                    for (var r in t)
                        n = n.concat(t[r].name, "=", t[r].value, "; ");
                o.headers.cookie = n,
                downloadByThunder(e.tabId, o, i)
            }
            )
        }
        )
    } while (0);return {}
}

function onBeforeSendHeaders(e) {
    console.log("onHeadersReceived")
    console.log(e.url)
    do {
        if (!isSupportRequestType(e.type))
            break;
        var t = this.requestItems[e.requestId];
        t || (t = new l,
        this.requestItems[e.requestId] = t),
        t.tabId = e.tabId;
        var i = e.url;
        t.url && 0 !== t.url.length || (t.url = i);
        for (var n = 0; n < e.requestHeaders.length; ++n) {
            var o = e.requestHeaders[n].name.toLowerCase()
              , r = e.requestHeaders[n].value;
            switch (o) {
            case "user-agent":
                t.headers["user-agent"] = r;
                break;
            case "referer":
                t.headers.referer = r;
                break;
            case "cookie":
                t.headers.cookie = r;
                break;
            case "content-type":
                t.headers["content-type"] = r
            }
        }
    } while (0);return {}
}

function isFrameRequestType(e) {
    return "main_frame" === e || "sub_frame" === e
}

function getUrlFileName(e) {
    var t = e.replace(/\?.*$/, "").replace(/.*\//, "");
    return decodeURIComponent(t)
}

function getFileNameExt(e) {
    var t = "";
    if (e.length > 0) {
        var i = e.lastIndexOf(".");
        -1 !== i && (t = (t = e.substr(i)).toLowerCase())
    }
    return t
}

function isSupportMediaExt(e) {
    for (var t in e = e.toLowerCase(),
    this.SUPPORT_MEDIA_EXT_ARRAY)
        if (e.toLowerCase() === this.SUPPORT_MEDIA_EXT_ARRAY[t])
            return !0;
    return !1
}

function isSupportContentType(e) {
    for (var t in e = e.toLowerCase(),
    this.MIME_TYPE_ARRAY)
        if (e.toLowerCase() === this.MIME_TYPE_ARRAY[t])
            return !0;
    return !1
}

function isValidDownload(e) {
    var t = ""
      , i = e.headers["content-disposition"];
    if (i.length > 0 && (t = this.getDispositionFileName(i)),
    0 === t.length && (t = this.getUrlFileName(e.url)),
    0 === t.length)
        return !1;
    e.fileName = t;
    var n = e.headers["content-type"];
    if (-1 !== n.indexOf("text/") && (-1 === n.indexOf("text/multipart") || 0 === t.length))
        return !1;
    var o = this.getFileNameExt(t);
    return e.ext = o,
    !!this.canDownload(e) && this.isMonitorFileExt(o)
}

function downloadByThunder(e, t, i) {
    if (t.headers.referer && 0 !== t.headers.referer.length)
        this.invokeThunder(t);
    else if (void 0 === e || e < 0)
        this.invokeThunder(t);
    else {
        var n = this;
        this.getHrefById(e, e=>{
            t.headers.referer = e,
            n.invokeThunder(t)
        }
        , i)
    }
}

function isSupportRequestType(e) {
    for (var t in e = e.toLowerCase(),
    this.SUPPORT_REQUEST_TYPE_ARRAY)
        if (e === this.SUPPORT_REQUEST_TYPE_ARRAY[t])
            return !0;
    return !1
}