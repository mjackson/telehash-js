var Duplex = require('stream').Duplex;
var lob = require('lob-enc');

// implements https://github.com/telehash/telehash.org/blob/v3/v3/channels/stream.md
exports.name = 'stream';

exports.mesh = function(mesh, cbExt)
{
  var ext = {open:{}};

  // incoming stream requests go here
  mesh.stream = function(onStream)
  {
    mesh.log.debug('adding onStream handler',typeof onStream);
    ext.onStream = onStream;
  }
  
  // takes any channel and returns a Duplex stream, oneshot is thtp style (one packet/channel)
  mesh.streamize = function(chan, encoding)
  {
    if(!encoding) encoding = 'binary';
    if(typeof chan != 'object' || !chan.isChannel)
    {
      mesh.log.warn('invalid channel passed to streamize');
      return false;
    }

    var stream = new Duplex({allowHalfOpen:false, objectMode:true});
    stream.on('finish',function(){
      chan.send({json:{end:true}});
    });

    stream.on('error',function(err){
      if(err == chan.err) return; // ignore our own generated errors
      mesh.log.debug('streamized error',err);
      chan.send({json:{err:err.toString()}});
    });

    stream._write = function(data,enc,cbWrite)
    {
      if(chan.state == 'gone') return cbWrite('closed');
      // switch to our default encoding syntax
      enc = encoding;
      // dynamically detect object streams and change encoding
      if(!Buffer.isBuffer(data) && typeof data != 'string')
      {
        data = JSON.stringify(data);
        enc = 'json';
      }
      // chunk it
      while(data.length)
      {
        var chunk = data.slice(0,1000);
        data = data.slice(1000);
        var packet = {json:{},body:chunk};
        // last packet gets continuation callback
        if(!data.length)
        {
          if(enc != 'binary') packet.json.enc = enc;
          packet.callback = cbWrite;
        }else{
          packet.json.chunk = true;
        }
        chan.send(packet);
      }
    }

    // handle backpressure flag from the pipe.push()
    var more = false;
    stream._read = function(size){
      if(more) more();
      more = false;
    };

    var data = new Buffer(0);
    chan.receiving = function(err, packet, cbMore) {
      // was a wait writing, let it through
      if(packet.body.length || data.length)
      {
        data = Buffer.concat([data,packet.body]);
        if(!packet.json.chunk)
        {
          var body = data;
          data = new Buffer(0);
          if(packet.json.enc == 'json') try{
            body = JSON.parse(body)
          }catch(E){
            mesh.log.warn('stream json chunk parse error',E,body.toString());
            err = E;
          }
          if(packet.json.enc == 'lob')
          {
            var packet = mesh.lib.lob.decode(body);
            if(!packet)
            {
              mesh.log.warn('stream lob chunk decode error',body.toString('hex'));
              err = 'lob decode failed';
            }else{
              body = packet;
            }
          }
          
          if(!err && !stream.push(body)) more = cbMore;
        }
      }
      if(err) return stream.emit('error',err);
      if(packet.json.end) stream.push(null);
      if(!more) cbMore();
    }

    return stream;
  }

  // new incoming stream open request
  ext.open.stream = function(args, open, cbOpen){
    var link = this;
    if(typeof ext.onStream != 'function') return cbOpen('no stream');
    // pass any attached request packet as options, and a method to accept
    ext.onStream(link, lob.decode(open.body), function accept(err){
      if(err) return cbOpen(err);
      var channel = link.x.channel(open);
      channel.receive(open); // actually opens it
      return mesh.streamize(channel);
    });
  }
  
  ext.link = function(link, cbLink)
  {
    // create a new stream to this link
    link.stream = function(packet, encoding)
    {
      var open = {json:{type:'stream'},body:packet};
      open.json.seq = 1; // always reliable
      var channel = link.x.channel(open);
      var stream = mesh.streamize(channel, encoding);
      channel.send(open);
      return stream;
    }

    cbLink();
  }
  
  cbExt(undefined, ext);
}
