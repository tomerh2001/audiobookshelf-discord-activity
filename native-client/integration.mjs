/** Exact anchors fail closed when upgrading the pinned upstream source. */
export async function integrate(replace) {
    await replace('client/components/app/Appbar.vue', 'src="~static/icon.svg"', 'src="/branding/audiobookshelf-listen-icon.png"');
    await replace('client/components/app/Appbar.vue', '>audiobookshelf</h1>', '>Audiobookshelf Listen</h1>');
    await replace('client/components/app/Appbar.vue', 'class="w-full h-16 bg-primary relative"', 'class="activity-appbar w-full h-16 bg-primary relative"');
    await replace('client/components/app/Appbar.vue', '      <div class="flex h-full items-center">', `      <div class="flex h-full items-center">
        <button v-if="$activity" type="button" class="activity-back-button" aria-label="Back" title="Back" @click="$activity.back()">
          <span class="material-symbols text-2xl" aria-hidden="true">arrow_back</span>
        </button>`);
    await replace('client/components/app/Appbar.vue', '<controls-global-search v-if="currentLibrary" class="mr-1 sm:mr-0"', '<controls-global-search v-if="currentLibrary" class="activity-global-search mr-1 sm:mr-0"');
    await replace('client/components/app/Appbar.vue', 'class="relative w-9 h-9 md:w-32', 'class="activity-account-button relative w-9 h-9 md:w-32');
    await replace('client/components/app/Appbar.vue', '        <nuxt-link to="/account"', `        <button v-if="$activity" type="button" class="activity-party-button" aria-label="Listening party" title="Listening party" aria-haspopup="dialog" :aria-expanded="$activity.state.rosterOpen" @click="$activity.roster()">
          <span class="material-symbols text-2xl" aria-hidden="true">groups</span>
        </button>
        <nuxt-link to="/account"`);
    await replace('client/layouts/default.vue', '<div class="text-white max-h-screen h-screen overflow-hidden bg-bg">', '<div class="activity-shell text-white bg-bg" :class="{ \'activity-preview\': $activity.state.preview, \'activity-playing\': !!$store.state.streamLibraryItem }">');
    await replace('client/layouts/default.vue', '    <app-appbar />', '    <app-appbar />\n    <discord-activity-controls />');
    await replace('client/layouts/default.vue', '<Nuxt :key="currentLang" />', `<Nuxt :key="String(currentLang) + ':' + $activity.state.accountRevision + ':' + $activity.state.browseRevision" />`);
    await replace('client/layouts/default.vue', '<app-media-player-container ref="mediaPlayerContainer" />', '<app-media-player-container :key="$activity.state.accountRevision" ref="mediaPlayerContainer" />');
    await replace('client/layouts/default.vue', '    this.initializeSocket()', '    // Activity uses its capability-scoped socket and filtered native events.');
    await replace('client/layouts/default.vue', '    this.checkVersionUpdate()', '    // Native releases are pinned and updated by the Activity operator.');
    await replace('client/layouts/default.vue', '    this.loadTasks()', '    // Administrative tasks are outside the listening Activity.');

    const component = 'client/components/app/MediaPlayerContainer.vue';
    await replace(component, 'class="w-full fixed bottom-0', 'class="activity-native-player w-full fixed bottom-0');
    await replace(component, 'class="absolute left-2 top-2 lg:left-4 cursor-pointer"', 'class="activity-player-cover absolute left-2 top-2 lg:left-4 cursor-pointer"');
    await replace(component, 'class="flex items-start mb-6 lg:mb-0"', 'class="activity-player-heading flex items-start mb-6 lg:mb-0"');
    await replace('client/components/player/PlayerUi.vue', 'class="w-full -mt-6"', 'class="activity-player-ui w-full -mt-6"');
    await replace('client/components/player/PlayerUi.vue', 'class="absolute -top-10 lg:top-0', 'class="activity-player-options absolute -top-10 lg:top-0');
    await replace('client/components/modals/Modal.vue', 'style="min-width: 380px; min-height: 200px; max-width: 100vw"', 'style="min-width: min(380px, 100vw); min-height: min(200px, 60dvh); max-width: 100vw; max-height: calc(100dvh - 60px); overflow-y: auto"');
    const hooks = {
        'mediaFinished(libraryItemId, episodeId)': 'ended(libraryItemId, episodeId)',
        'playPause()': 'playPause()',
        'jumpForward()': 'jump(this.playerHandler.jumpForwardAmount)',
        'jumpBackward()': 'jump(-this.playerHandler.jumpBackwardAmount)',
        'setPlaybackRate(playbackRate)': 'rate(playbackRate)',
        'seek(time)': 'seek(time)',
        'closePlayer()': 'stop()',
        'mediaSessionPlay()': 'play()',
        'mediaSessionPause()': 'pause()',
        'mediaSessionStop()': 'stop()',
        'mediaSessionSeekBackward()': 'jump(-this.playerHandler.jumpBackwardAmount)',
        'mediaSessionSeekForward()': 'jump(this.playerHandler.jumpForwardAmount)',
        'mediaSessionSeekTo(e)': 'seek(e.seekTime)',
        'playNextItemInQueue()': 'next()',
        'playQueueItem(payload)': 'selectIndex(payload.index)',
        'async playLibraryItem(payload)': 'playSelection(payload)',
        'pauseItem()': 'pause()'
    };
    for (const [method, call] of Object.entries(hooks)) await replace(component, `    ${method} {`, `    ${method} {\n      if (this.$activity) return this.$activity.player?.${call}`);
    await replace(component, '    playbackTimeUpdate(time) {', '    playbackTimeUpdate(time) {\n      if (this.$activity) return // The verified Activity owns the shared timeline.');
    await replace(component, '    sleepTimerEnd() {', '    sleepTimerEnd() {\n      if (this.$activity?.player) { this.clearSleepTimer(); this.$activity.player.localPause(); return }');
    await replace(component, '  mounted() {', '  mounted() {\n    this.$activity?.attach(this)');
    await replace(component, '  beforeDestroy() {', '  beforeDestroy() {\n    this.$activity?.detach(this)');
    // Duplicate items are distinct queue entries, unlike upstream's media-ID lookup.
    await replace(component, '    currentPlayerQueueIndex() {', '    currentPlayerQueueIndex() {\n      if (this.$activity?.state.snapshot) return this.$activity.state.snapshot.index');

    const handler = 'client/players/PlayerHandler.js';
    await replace(handler, '    this.ctx = ctx', '    this.ctx = ctx\n    this.activityGeneration = 0\n    this.activityTranscodeRetries = 0');
    await replace(handler, '    this.libraryItem = libraryItem', '    this.activityGeneration++\n    this.activityTranscodeRetries = 0\n    this.libraryItem = libraryItem');
    await replace(handler, '  async prepare(forceTranscode = false) {', '  async prepare(forceTranscode = false) {\n    const generation = this.activityGeneration');
    await replace(handler, '    this.prepareSession(session)', `    if (!session || generation !== this.activityGeneration) {
      if (session?.id) this.ctx.$axios.$post('/api/session/' + encodeURIComponent(session.id) + '/close').catch(() => {})
      if (!session && generation === this.activityGeneration) { this.playerStateChange('ERROR'); this.ctx.$toast.error('Audiobookshelf could not prepare playback. Try Play again.') }
      return
    }
    this.prepareSession(session)`, 1);
    await replace(handler, '  resetPlayer() {', '  resetPlayer() {\n    this.activityGeneration++');
    await replace(handler, '  sendCloseSession() {', '  sendCloseSession() {\n    if (!this.currentSessionId) return Promise.resolve()');
    await replace(handler, '  playerError() {', `  playerError() {
    if (++this.activityTranscodeRetries > 2) { this.playerStateChange('ERROR'); this.ctx.$toast.error('Audio playback failed. Try another format or reconnect.'); return }`);
    await replace(handler, '    console.log(\'[PlayerHandler] Preparing Session\', session)', '    // Capability-bearing playback metadata is never written to browser logs.');
    // Avoid exposing protected cover URLs to OS-level media metadata.
    await replace(component, "src: this.$store.getters['globals/getLibraryItemCoverSrc'](this.streamLibraryItem, '/Logo.png', true)", "src: window.location.origin + '/branding/audiobookshelf-listen-icon.png'");

    const local = 'client/players/LocalAudioPlayer.js';
    await replace(local, '    if (this.player) this.player.play()', `    if (this.player) {
      const element = this.player
      try {
        Promise.resolve(element.play()).catch(error => {
          if (error?.name === 'NotAllowedError') element.dispatchEvent(new Event('audiobookshelf-activity-playback-blocked', { bubbles: true }))
          else this.emit('error')
        })
      } catch (error) {
        if (error?.name === 'NotAllowedError') element.dispatchEvent(new Event('audiobookshelf-activity-playback-blocked', { bubbles: true }))
        else this.emit('error')
      }
    }`);
    await replace(local, '    this.player = audioEl', "    this.player = audioEl\n    audioEl.addEventListener('playing', () => this.emit('stateChange', 'PLAYING'))");
    await replace(local, "    this.emit('stateChange', 'PLAYING')", '    // Only the actual playing event establishes playback, not an attempted play.', 1);
    await replace(local, '    if (this.player) {\n      this.player.remove()', '    if (this.player) {\n      this.player.pause()\n      this.player.removeAttribute("src")\n      this.player.load()\n      this.player.remove()');
    await replace(local, '    var hlsOptions = {', '    var hlsOptions = {\n      workerPath: "/hls.worker.js",\n      maxBufferLength: 30,\n      maxMaxBufferLength: 60,\n      backBufferLength: 30,\n      maxBufferSize: 96 * 1024 * 1024,');
    await replace(local, '    console.log(`[LocalPlayer] Loading track src ${this.currentTrack.relativeContentUrl}`)', '    // Media URLs contain an Activity capability.');
    await replace(local, '    await new Promise((resolve) => setTimeout(resolve, 1000))\n    this.set(', '    const element = this.player\n    await new Promise((resolve) => setTimeout(resolve, 1000))\n    if (!element?.isConnected || this.player !== element) return\n    this.set(');

    await replace('client/players/AudioTrack.js', '    if (this.contentUrl?.startsWith(\'/hls\')) {', "    if (this.contentUrl?.startsWith(routerBasePath + '/hls/')) {\n      this.sessionTrackUrl = this.contentUrl.slice(routerBasePath.length)\n    } else if (this.contentUrl?.startsWith('/hls')) {");
    await replace('client/store/globals.js', '    return `${rootState.routerBasePath}/book_placeholder.jpg`', "    return '/book_placeholder.jpg'");
    await replace('client/store/globals.js', "      if (media.coverPath.startsWith('http:') || media.coverPath.startsWith('https:')) return media.coverPath", '      // Always load protected artwork through the gateway.');
    await replace('client/components/player/PlayerUi.vue', '    init() {', `    init() {
      if (this.$activity) {
        this.playbackRate = this.$activity.state.snapshot?.playbackRate || 1
        if (this.$refs.trackbar) this.$refs.trackbar.setUseChapterTrack(this.useChapterTrack)
        return
      }`);
    await replace('client/components/controls/PlaybackSpeedControl.vue', '      MAX_SPEED: 10,', '      MAX_SPEED: 3,');
    await replace(component, 'this.playerHandler.currentStreamId', 'this.playerHandler.currentSessionId', 1);
    await replace(component, 'this.playerHandler.currentStreamId', 'this.playerHandler.currentSessionId', 1);
    await replace(component, 'this.playerHandler.currentStreamId', 'this.playerHandler.currentSessionId', 1);
    await replace('client/store/index.js', '  addItemToQueue(state, item) {', '  addItemToQueue(state, item) {\n    state.playerQueueItems.push({ ...item }); return // Activity queue entries have independent identities.');
    await replace('client/store/index.js', '  removeItemFromQueue(state, item) {', '  removeItemFromQueue(state, item) {\n    if (item.activityEntryId) { state.playerQueueItems = state.playerQueueItems.filter(value => value.activityEntryId !== item.activityEntryId); return }');
    await replace('client/components/modals/player/QueueItemRow.vue', '    isOpenInPlayer() {', '    isOpenInPlayer() {\n      if (this.$activity?.state.snapshot) return this.item.activityEntryId === this.$activity.state.snapshot.queue[this.$activity.state.snapshot.index]?.id');
    await replace('client/components/modals/player/QueueItemRow.vue', 'class="w-full flex items-center px-4 py-2"', 'class="activity-queue-item w-full flex items-center px-4 py-2"');
    await replace('client/components/modals/player/QueueItemRow.vue', '    <div class="w-28">', `    <div v-if="$activity" class="activity-queue-actions" @click.stop>
      <button v-if="!isOpenInPlayer" @click="playClick">Play</button>
      <button v-if="!isOpenInPlayer" @click="$activity.player.playNext(item.activityEntryId)">Play next</button>
      <button :disabled="index === 0" aria-label="Move earlier in queue" @click="$activity.player.moveQueueItem(item.activityEntryId, index - 1)">↑</button>
      <button :disabled="!$activity.state.snapshot || index === $activity.state.snapshot.queue.length - 1" aria-label="Move later in queue" @click="$activity.player.moveQueueItem(item.activityEntryId, index + 1)">↓</button>
      <button @click="removeClick" aria-label="Remove from queue">Remove</button>
    </div>
    <div v-else class="w-28">`);
    await replace('client/components/modals/player/QueueItemsModal.vue', ':key="index" :item="item"', ':key="item.activityEntryId || index" :item="item"');
    await replace('client/components/modals/player/QueueItemsModal.vue', '<ui-checkbox v-model="playerQueueAutoPlay"', '<ui-checkbox v-if="!$activity" v-model="playerQueueAutoPlay"');
    await replace('client/components/modals/player/QueueItemsModal.vue', '          <div class="grow" />', `          <div class="grow" />
          <div v-if="$activity && playerQueueItems.length > 1" class="activity-queue-actions">
            <button @click="$activity.player.shuffleQueue()">Shuffle</button>
            <button @click="$activity.player.clearUpcoming()">Clear upcoming</button>
          </div>`);
    await replace('client/components/modals/player/QueueItemsModal.vue', '        <div class="pb-4 px-4 flex items-center">', '        <div class="activity-queue-header pb-4 px-4 flex items-center">');
    await replace('client/components/modals/player/QueueItemsModal.vue', '        <modals-player-queue-item-row', `        <div v-if="$activity && $activity.state.snapshot" class="activity-queue-controls">
          <button aria-label="Previous item" :disabled="$activity.state.snapshot.index <= 0" @click="$activity.player.previous()">Previous</button>
          <button aria-label="Next item" :disabled="$activity.state.snapshot.index < 0 || $activity.state.snapshot.index >= $activity.state.snapshot.queue.length - 1" @click="$activity.player.next()">Next</button>
          <label>Repeat
            <select aria-label="Party repeat mode" :value="$activity.state.snapshot.repeatMode" @change="$activity.player.repeat($event.target.value)">
              <option value="RepeatNone">No repeat</option><option value="RepeatOne">Repeat one</option><option value="RepeatAll">Repeat all</option>
            </select>
          </label>
        </div>
        <modals-player-queue-item-row`);
    await replace('client/pages/item/_id/index.vue', '            <ui-tooltip v-if="showQueueBtn"', `            <ui-btn v-if="$activity && showPlayButton && !isPodcast" small class="mr-2" @click="$activity.player.queueSelection({ libraryItemId })">Play next</ui-btn>
            <ui-tooltip v-if="showQueueBtn"`);
    await replace('client/components/tables/podcast/LazyEpisodeRow.vue', '          <ui-tooltip v-if="libraryItemIdStreaming', `          <button v-if="$activity" class="px-2 text-sm" @click.stop="$activity.player.queueSelection({ libraryItemId, episodeId })">Play next</button>
          <ui-tooltip v-if="libraryItemIdStreaming`);
    await replace('client/pages/item/_id/index.vue', '    showReadButton() {\n      return this.ebookFile', '    showReadButton() {\n      return false');
    for (const event of ['item_updated', 'rss_feed_open', 'rss_feed_closed', 'share_open', 'share_closed', 'episode_download_queued', 'episode_download_started', 'episode_download_finished', 'episode_download_queue_cleared']) {
        for (const method of ['on', 'off']) await replace('client/pages/item/_id/index.vue', `this.$root.socket.${method}('${event}'`, `this.$root.socket?.${method}('${event}'`);
    }
    await replace('client/pages/item/_id/index.vue', '<tables-ebook-files-table v-if="ebookFiles.length"', '<tables-ebook-files-table v-if="false"');
    await replace('client/components/cards/LazyBookCard.vue', '    showReadButton() {\n      return !this.isSelectionMode && !this.showPlayButton && this.ebookFormat', '    showReadButton() {\n      return false');
    await replace('client/components/cards/LazyBookCard.vue', '    showSmallEBookIcon() {\n      return !this.isSelectionMode && this.ebookFormat', '    showSmallEBookIcon() {\n      return false');
    await replace('client/store/libraries.js', "        console.error('Failed', error)", "        if (error.activityStale) return false\n        console.error('Failed', error)", 1);
    await replace('client/store/libraries.js', "        console.error('Failed', error)\n        commit('set', [])", "        if (error.activityStale) return false\n        console.error('Failed', error)\n        commit('set', [])");

}
