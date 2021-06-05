const ytdl = require("ytdl-core"),
  ytpl = require("@distube/ytpl"),
  Song = require("../struct/Song"),
  SearchResult = require("../struct/SearchResult"),
  Playlist = require("../struct/Playlist"),
  { isURL } = require("../struct/Util"),
  DisTubeBase = require("./DisTubeBase"),
  Discord = require("discord.js"),
  Queue = require("../struct/Queue"),
  DisTubeStream = require("./DisTubeStream"),
  { Transform } = require("stream");

/**
 * DisTube's Handler
 * @extends DisTubeBase
 * @private
 */
class DisTubeHandler extends DisTubeBase {
  constructor(distube) {
    super(distube);
    const requestOptions = this.options.youtubeCookie ? { headers: { cookie: this.options.youtubeCookie, "x-youtube-identity-token": this.options.youtubeIdentityToken } } : undefined;
    this.ytdlOptions = Object.assign(this.options.ytdlOptions, { requestOptions });
  }

  /**
   * Emit error event
   * @param {Discord.TextChannel} channel Text channel where the error is encountered.
   * @param {Error} error error
   * @private
   */
  emitError(channel, error) {
    this.distube.emitError(channel, error);
  }

  /**
   * Delete a guild queue
   * @param {Discord.Snowflake|Discord.Message|Queue} queue A message from guild channel | Queue
   */
  deleteQueue(queue) {
    this.distube._deleteQueue(queue);
  }

  /**
   * @param {string} url url
   * @param {boolean} [basic=false] getBasicInfo?
   * @returns {Promise<ytdl.videoInfo>}
   */
  getYouTubeInfo(url, basic = false) {
    if (basic) return ytdl.getBasicInfo(url, this.ytdlOptions);
    return ytdl.getInfo(url, this.ytdlOptions);
  }

  /**
   * Resolve a Song
   * @param {Discord.Message|Discord.GuildMember} message A message from guild channel | A guild member
   * @param {string|Song|SearchResult|Playlist} song YouTube url | Search string | {@link Song}
   * @returns {Promise<Song|Array<Song>|Playlist>} Resolved Song
   */
  async resolveSong(message, song) {
    if (!song) return null;
    const member = message?.member || message;
    if (song instanceof Song || song instanceof Playlist) return song;
    if (song instanceof SearchResult) {
      if (song.type === "video") return new Song(song, member);
      else if (song.type === "playlist") return this.resolvePlaylist(message, song.url);
      throw new Error("Invalid SearchResult");
    }
    if (typeof song === "object") return new Song(song, member);
    if (ytdl.validateURL(song)) return new Song(await this.getYouTubeInfo(song), member);
    if (isURL(song)) {
      for (const plugin of this.distube.extractorPlugins) if (await plugin.validate(song)) return plugin.resolve(song, member);
      throw new Error("Not Supported URL!");
    }
    if (typeof song !== "string") throw new TypeError("song is not a valid type");
    if (message instanceof Discord.GuildMember) song = (await this.distube.search(song, { limit: 1 }))[0];
    else song = await this.searchSong(message, song);
    return this.resolveSong(message, song);
  }

  /**
   * Resole Song[] or url to a Playlist
   * @param {Discord.Message|Discord.GuildMember} message A message from guild channel | A guild member
   * @param {Array<Song>|string} playlist Resolvable playlist
   * @param {string} [source="youtube"] Playlist source
   * @returns {Promise<Playlist>}
   */
  async resolvePlaylist(message, playlist, source = "youtube") {
    const member = message?.member || message;
    if (typeof playlist === "string") {
      playlist = await ytpl(playlist, { limit: Infinity });
      playlist.items = playlist.items.filter(v => !v.thumbnail.includes("no_thumbnail")).map(v => new Song(v, member));
    }
    if (!(playlist instanceof Playlist)) playlist = new Playlist(playlist, member, { source });
    return playlist;
  }

  /**
   * Create a custom playlist
   * @returns {Promise<Playlist>}
   * @param {Discord.Message|Discord.GuildMember} message A message from guild channel | A guild member
   * @param {Array<string|Song|SearchResult>} songs Array of url, Song or SearchResult
   * @param {Object} [properties={}] Additional properties such as `name`
   * @param {boolean} [parallel=true] Whether or not fetch the songs in parallel
   */
  async createCustomPlaylist(message, songs, properties = {}, parallel = true) {
    const member = message?.member || message;
    if (!Array.isArray(songs)) throw new TypeError("songs must be an array of url");
    if (!songs.length) throw new Error("songs is an empty array");
    songs = songs.filter(song => song instanceof Song || song instanceof SearchResult || isURL(song));
    if (!songs.length) throw new Error("songs does not have any valid Song, SearchResult or url");
    if (parallel) {
      songs = songs.map(song => this.resolveSong(member, song).catch(() => undefined));
      songs = await Promise.all(songs);
    } else {
      const resolved = [];
      for (const song of songs) resolved.push(await this.resolveSong(member, song).catch(() => undefined));
      songs = resolved;
    }
    return new Playlist(songs.filter(song => song), member, properties);
  }

  /**
   * Play / add a playlist
   * @returns {Promise<void>}
   * @param {Discord.Message|Discord.VoiceChannel|Discord.StageChannel} message A message from guild channel | a voice channel
   * @param {Playlist|string} playlist A YouTube playlist url | a Playlist
   * @param {boolean} [textChannel] The default text channel of the queue
   * @param {boolean} [skip=false] Skip the current song
   */
  async handlePlaylist(message, playlist, textChannel = false, skip = false) {
    if (typeof textChannel === "boolean") {
      skip = textChannel;
      textChannel = message.channel;
    }
    if (!playlist || !(playlist instanceof Playlist)) throw Error("Invalid Playlist");
    if (this.options.nsfw && !textChannel?.nsfw) {
      playlist.songs = playlist.songs.filter(s => !s.age_restricted);
    }
    if (!playlist.songs.length) {
      if (this.options.nsfw && !textChannel?.nsfw) {
        throw new Error("No valid video in the playlist.\nMaybe age-restricted contents is filtered because you are in non-NSFW channel.");
      }
      throw Error("No valid video in the playlist");
    }
    const songs = playlist.songs;
    let queue = this.distube.getQueue(message);
    if (queue) {
      queue.addToQueue(songs, skip);
      if (skip) queue.skip();
      else this.emit("addList", queue, playlist);
    } else {
      queue = await this.distube._newQueue(message, songs, textChannel);
      if (queue !== true) this.emit("playSong", queue, queue.songs[0]);
    }
  }

  /**
   * Search for a song, fire {@link DisTube#event:error} if not found.
   * @param {Discord.Message} message A message from guild channel
   * @param {string} query The query string
   * @returns {Promise<Song?>} Song info
   */
  async searchSong(message, query) {
    const limit = this.options.searchSongs > 1 ? this.options.searchSongs : 1;
    const results = await this.distube.search(query, {
      limit,
      safeSearch: this.options.nsfw ? false : !message.channel?.nsfw,
    }).catch(() => undefined);
    if (!results?.length) {
      this.emit("searchNoResult", message, query);
      return null;
    }
    let result = results[0];
    if (limit > 1) {
      this.emit("searchResult", message, results, query);
      const answers = await message.channel.awaitMessages(m => m.author.id === message.author.id, {
        max: 1,
        time: this.options.searchCooldown * 1000,
        errors: ["time"],
      }).catch(() => undefined);
      const ans = answers?.first();
      if (!ans) {
        this.emit("searchCancel", message, query);
        return null;
      }
      const index = parseInt(ans.content, 10);
      if (isNaN(index) || index > results.length || index < 1) {
        this.emit("searchCancel", message, query);
        return null;
      }
      this.emit("searchDone", message, ans, query);
      result = results[index - 1];
    }
    return result;
  }

  /**
   * Join the voice channel
   * @param {Queue} queue A message from guild channel
   * @param {Discord.VoiceChannel|Discord.StageChannel} voice The string search for
   * @param {boolean} retried retried?
   * @throws {Error}
   * @returns {Promise<Queue|true>} `true` if queue is not generated
   */
  async joinVoiceChannel(queue, voice, retried = false) {
    try {
      queue.connection = await voice.join();
      this.emit("connect", queue);
      queue.connection.on("disconnect", () => {
        this.emit("disconnect", queue);
        try { queue.stop() } catch { this.deleteQueue(queue) }
      }).on("error", e => {
        try {
          e.name = "VoiceConnection";
        } catch { }
        this.emitError(queue.textChannel, e);
        try { queue.stop() } catch { this.deleteQueue(queue) }
      });
      const err = await this.playSong(queue);
      return err || queue;
    } catch (e) {
      this.deleteQueue(queue);
      try {
        e.name = "JoinVoiceChannel";
      } catch { }
      if (retried) throw e;
      return this.joinVoiceChannel(queue, voice, true);
    }
  }

  /**
   * Create a ytdl stream
   * @param {Queue} queue Queue
   * @returns {Transform}
   */
  createStream(queue) {
    const song = queue.songs[0];
    const filterArgs = [];
    queue.filters.forEach(filter => filterArgs.push(this.distube.filters[filter]));
    const FFmpegArgs = queue.filters?.length ? ["-af", filterArgs.join(",")] : null;
    const seek = song.duration ? queue.beginTime : undefined;
    const streamOptions = { FFmpegArgs, seek };
    Object.assign(streamOptions, this.ytdlOptions);
    if (song.source === "youtube") return DisTubeStream.YouTube(song.info, streamOptions);
    return DisTubeStream.DirectLink(song.streamURL, streamOptions);
  }

  /**
   * Whether or not emit playSong event
   * @param {Queue} queue Queue
   * @private
   * @returns {boolean}
   */
  _emitPlaySong(queue) {
    if (
      !this.options.emitNewSongOnly ||
      (queue.repeatMode !== 1 && queue.songs[0]?.id !== queue.songs[1]?.id)
    ) return true;
    return false;
  }

  /**
   * Play a song on voice connection
   * @param {Queue} queue The guild queue
   * @returns {Promise<boolean>} error?
   */
  async playSong(queue) {
    if (!queue) return true;
    if (!queue.songs.length) {
      this.deleteQueue(queue);
      return true;
    }
    const song = queue.songs[0];
    try {
      let errorEmitted = false;
      const { url } = song;
      if (song.source === "youtube" && !song.info) song._patchYouTube(await this.getYouTubeInfo(url));
      if (song.source !== "youtube" && !song.streamURL) {
        for (const plugin of this.distube.extractorPlugins.concat(this.distube.customPlugins)) {
          if (await plugin.validate(url)) {
            const info = [
              plugin.getStreamURL(url),
              plugin.getRelatedSongs(url),
            ];
            const result = await Promise.all(info);
            song.streamURL = result[0];
            song.related = result[1];
            break;
          }
        }
      }
      const stream = this.createStream(queue).on("error", e => {
        errorEmitted = true;
        try {
          e.name = "Stream";
          e.message = `${e.message}\nID: ${song.id}\nName: ${song.name}`;
        } catch { }
        this.emitError(queue.textChannel, e);
      });
      queue.dispatcher = queue.connection.play(stream, {
        highWaterMark: 1,
        type: "opus",
        volume: queue.volume / 100,
        bitrate: "auto",
      }).on("finish", () => { this._handleSongFinish(queue) })
        .on("error", e => { this._handlePlayingError(queue, errorEmitted ? null : e) });
      if (queue.stream) queue.stream.destroy();
      queue.stream = stream;
      return false;
    } catch (e) {
      this._handlePlayingError(queue, e);
      return true;
    }
  }

  /**
   * Handle the queue when a Song finish
   * @private
   * @param {Queue} queue queue
   * @returns {Promise<void>}
   */
  async _handleSongFinish(queue) {
    this.emit("finishSong", queue, queue.songs[0]);
    if (queue.stopped) {
      this.deleteQueue(queue);
      return;
    }
    if (queue.repeatMode === 2 && !queue.prev) queue.songs.push(queue.songs[0]);
    if (queue.prev) {
      if (queue.repeatMode === 2) queue.songs.unshift(queue.songs.pop());
      else queue.songs.unshift(queue.previousSongs.pop());
    }
    if (queue.songs.length <= 1 && (queue.next || !queue.repeatMode)) {
      if (queue.autoplay) try { await queue.addRelatedSong() } catch { this.emit("noRelated", queue) }
      if (queue.songs.length <= 1) {
        if (this.options.leaveOnFinish) queue.connection.channel.leave();
        if (!queue.autoplay) this.emit("finish", queue);
        this.deleteQueue(queue);
        return;
      }
    }
    const emitPlaySong = this._emitPlaySong(queue);
    if (!queue.prev && (queue.repeatMode !== 1 || queue.next)) {
      const prev = queue.songs.shift();
      delete prev.info;
      delete prev.streamURL;
      if (this.options.savePreviousSongs) queue.previousSongs.push(prev);
      else queue.previousSongs.push({ id: prev.id });
    }
    queue.next = queue.prev = false;
    queue.beginTime = 0;
    const err = await this.playSong(queue);
    if (!err && emitPlaySong) this.emit("playSong", queue, queue.songs[0]);
  }

  /**
   * Handle error while playing
   * @private
   * @param {Queue} queue queue
   * @param {Error} error error
   */
  _handlePlayingError(queue, error = null) {
    const song = queue.songs.shift();
    if (error) {
      try {
        error.name = "Playing";
        error.message = `${error.message}\nID: ${song.id}\nName: ${song.name}`;
      } catch { }
      this.emitError(queue.textChannel, error);
    }
    if (queue.songs.length > 0) {
      this.playSong(queue).then(e => {
        if (!e) this.emit("playSong", queue, queue.songs[0]);
      });
    } else try { queue.stop() } catch { this.deleteQueue(queue) }
  }

  /**
   * Check if the voice channel is empty
   * @param {Discord.VoiceState} voiceState voiceState
   * @returns {boolean}
   */
  isVoiceChannelEmpty(voiceState) {
    const voiceChannel = voiceState.guild?.me?.voice?.channel;
    if (!voiceChannel) return false;
    const members = voiceChannel.members.filter(m => !m.user.bot);
    return !members.size;
  }
}

module.exports = DisTubeHandler;