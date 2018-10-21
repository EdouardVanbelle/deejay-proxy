var http   = require('http'),
    https  = require('https'),
    events = require('events');

//FIXME: should fake classic user agent
const agent = new http.Agent({ keepAlive: true });

var MAXSEGMENTS    = 5;
var MINSEGMENTS    = 3;
var BUFMAX         = 1024*196*MAXSEGMENTS;

var last           = 0;
var buffer         = new Buffer.alloc( BUFMAX);

//FIXME: URL may change...
//var STARTPLAYLIST  = 'https://radiodeejay-lh.akamaihd.net/i/RadioDeejay_Live_1@189857/master.m3u8';
var STARTPLAYLIST  = 'http://radiocapital-lh.akamaihd.net/i/RadioCapital_Live_1@196312/master.m3u8';
//var STARTPLAYLIST= 'https://capital_wr_03-lh.akamaihd.net/i/WebRadio3_1@13883/master.m3u8'; //radio capital Funky
var playlistUrl    = '';
var bufferQueue    = new Array();
var segment        = new Array();

var interval       = null; // clearInterval
var client         = null;
var hasClients	   = true; // FIXME: proxy run only if has clients

var adapterFor = (function() {
  var url = require('url'),
  adapters = {
	  'http:': require('http'),
	  'https:': require('https'),
  };

  return function(inputUrl) {
      return adapters[url.parse(inputUrl).protocol]
  }
}());

function refreshPlaylist() {
	console.log( "updating playlist...");

	adapterFor( playlistUrl).get( playlistUrl, function(resp) {

	        if (resp.statusCode != 200) {
		    throw new Error( "Critical: unable to get playlist "+playlistUrl+": "+resp.statusMessage);
	        }

		if (resp.headers['content-type'] != 'application/vnd.apple.mpegurl') {
		    throw new Error( "Critical: wrong playlist "+playlistUrl+" answer: "+resp.headers['content-type']);
		}

		var body = '';
		resp.on( 'data', function( chunk) { body += chunk } );
		resp.on( 'end',  function() {
			var lines = body.split(/\n/);
			LOOP: for (var i=0; i< lines.length; i++) {
				var line = lines[i];
				if( line.match( /^#/)) continue;
				if( line.match( /^\s*$/)) continue;
				if( ! (line.match( /^http/))) continue;
				if( bufferQueue.indexOf( line) != -1) continue; //already existss
				for( var j = 0; j < segment.length; j++) {
					if( segment[j].url == line) continue LOOP; // already buffered
				}

				bufferQueue.push( line);

				//got enought streams, start buffering
				if (bufferQueue.length >= MINSEGMENTS)
					bufferize();
			}
		});	
	});

}

function bufferize() {

    if( bufferQueue.length == 0)
	return; //nothing to buffer anymore

    url = bufferQueue.shift();

    adapterFor(url).get( url, function(resp) {

	    if (resp.statusCode != 200) {
		throw new Error( "Critical: unable to get segment "+url+": "+resp.statusMessage);
	    }

	    if (resp.headers['content-type'] != 'video/MP2T') {
	        throw new Error( "Critical: wrong segment "+url+" content-type");
	    }

	    var explen = parseInt( resp.headers['content-length'], 10);

	    //security
	    if(explen > (BUFMAX / MAXSEGMENTS)) {
		    throw new Error( "Critical: please enlarge BUFMAX");
	    }

	    if ((last + explen) > BUFMAX) {
		    console.log("rotating buffer (to avoid overflow)");
		    //rotate
		    last = 0; // restart from beginning of buffer
	    }
	    var start = last;

	    resp.on( 'data', function(chunk) {
		    chunk.copy( buffer, last);
		    last += chunk.length
	    });
	    resp.on( 'end', function() {

		var ptr = { 'start':start, 'end':last-1, 'url': url };

		segment.push( ptr);

		if (segment.length > MAXSEGMENTS)
			    segment.shift(); //keep always MAXSEGMENTS

			var shorturl = url.replace(/(.*\/\/[^\/]+\/).*\//, '$1.../').replace(/\?.*$/, '');
		console.log("new segment buffered ("+segment.length+"/"+MAXSEGMENTS+") @"+ptr.start+".."+ptr.end+" (len: "+explen+") "+shorturl);

		//FIXME: accept only 1 client
		if ( client != null) {
			console.log("forwarding this new buffer to client");
    			client.write( buffer.slice( ptr.start, ptr.end));
		}

		//if still have buffer to save
		bufferize();

	    });
    
    });
}

adapterFor( STARTPLAYLIST).get( STARTPLAYLIST, function(resp) {

	if (resp.statusCode != 200) {
	    throw new Error( "Critical: unable to get playlist: "+resp.statusMessage);
	}

	if (resp.headers['content-type'] != 'application/vnd.apple.mpegurl') {
	    throw new Error( "Critical: wrong playlist answer");
	}

	var body = '';

	resp.on( 'data', function( chunk) { body += chunk } );
	resp.on( 'end',  function() {
		var lines = body.split(/\n/);
		var url;
		do {
			url = lines.pop();
			if( url.match( /^http/)) {
				playlistUrl = url;
				break;
			}
		} while (lines.length);

		refreshPlaylist();
		interval = setInterval( refreshPlaylist, 10*1000);
	});
});

var server = http.createServer( function(request, response) {

    var cid = request.socket.localAddress+":"+request.socket.localPort;
    console.log( "got client request from "+cid);

    response.writeHead(200, {
	    'Content-Type': 'video/MP2T',
	    'Transfer-Encoding': 'chunked',
	    'Cache-Control': 'max-age=0, no-cache, no-store',
	    'Pragma': 'no-cache'
    });


    for( var i = 0; i < segment.length; i++) {
    	console.log( cid+" sending segment "+i+": @"+segment[i].start +".."+segment[i].end);
    	response.write( buffer.slice( segment[i].start, segment[i].end));
    }

    //FIXME: not multiuser acceptable
    client = response;

    response.on( 'checkContinue', function() { 
	    client.writeContinue() 
    });

    request.socket.on( "close", function() { 
	    console.log( cid+" connection closed"); 
	    response.end();
	    client = null; 
    });

});

server.on('clientError', function(err, socket) {
	  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(2000, '0.0.0.0');
