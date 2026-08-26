<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/stores'
  import { theme, monitors } from '$lib/stores'
  import { api } from '$lib/api'
  import { t } from '$lib/i18n'
  import { POLL_INTERVAL_MS } from '$lib/poll'
  import Icon from '$lib/components/Icon.svelte'

  const APP_VERSION = __APP_VERSION__
  const GITHUB_REPO = 'butialabs/pingflare'

  function isNewer(remote: string, local: string): boolean {
    const parse = (v: string) => {
      const [main, pre] = v.split('-')
      const [major, minor, patch] = main.split('.').map(Number)
      let preNum = Infinity
      if (pre) {
        const m = pre.match(/(\d+)$/)
        preNum = m ? parseInt(m[1]) : 0
      }
      return [major, minor, patch, preNum] as const
    }
    const r = parse(remote)
    const l = parse(local)
    for (let i = 0; i < 4; i++) {
      if (r[i] > l[i]) return true
      if (r[i] < l[i]) return false
    }
    return false
  }

  let countdown = POLL_INTERVAL_MS / 1000
  let countTicker: ReturnType<typeof setInterval>
  let updateAvailable = false
  let latestVersion = ''
  let menuOpen = false
  /** Origin runs behind an external identity proxy -- no login, no sign-out. */
  let authDisabled = false

  onMount(async () => {
    const hasToken = !!localStorage.getItem('token')
    const probe = api.auth.config().then(cfg => (authDisabled = cfg.authDisabled))
    // Anonymous visitors have to wait on the probe before the guard can decide.
    // With a token already in hand the guard passes either way, so the probe
    // only feeds the sign-out button and need not block the first paint.
    if (!hasToken) {
      await probe
      if (!authDisabled) {
        goto('/login')
        return
      }
    }
    countTicker = setInterval(() => {
      countdown = countdown <= 1 ? POLL_INTERVAL_MS / 1000 : countdown - 1
    }, 1000)

    const cacheKey = 'pf_latest_version'
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      latestVersion = cached
      updateAvailable = isNewer(cached, APP_VERSION)
    } else {
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`, {
          headers: { Accept: 'application/vnd.github+json' },
        })
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length > 0) {
            latestVersion = (data[0].tag_name as string).replace(/^v/, '')
            sessionStorage.setItem(cacheKey, latestVersion)
            updateAvailable = isNewer(latestVersion, APP_VERSION)
          }
        }
      } catch {
        // Silently ignore
      }
    }
  })
  onDestroy(() => clearInterval(countTicker))

  function logout() {
    localStorage.removeItem('token')
    goto('/login')
  }

  $: nav = [
    { href: '/',          label: $t('nav.dashboard'),     icon: 'home'                 },
    { href: '/monitors',  label: $t('nav.monitors'),      icon: 'signal'               },
    { href: '/status',    label: $t('nav.statusPages'),   icon: 'globe'                },
    { href: '/incidents', label: $t('nav.incidents'),     icon: 'exclamation-triangle' },
    { href: '/settings',  label: $t('nav.notifications'), icon: 'bell'                 },
    { href: '/config',    label: $t('nav.config'),        icon: 'cog'                  },
  ]

  function isActive(href: string, pathname: string) {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  $: {
    if (typeof document !== 'undefined') {
      const anyDown    = $monitors.some(m => m.lastStatus === 'down')
      const anyPending = $monitors.length > 0 && $monitors.some(m => m.lastStatus === 'pending')
      const color = anyDown ? '#ef4444' : anyPending ? '#f97316' : '#22c55e'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${color}"/></svg>`
      const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) {
        link = document.createElement('link')
        link.rel = 'icon'
        link.type = 'image/svg+xml'
        document.head.appendChild(link)
      }
      link.href = dataUrl
    }
  }
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen flex flex-col" style="background-color: rgb(var(--bg))">

  <header style="background-color: rgb(var(--bg-subtle)); border-bottom: 1px solid var(--border-color)">
    <div class="max-w-5xl mx-auto flex items-center h-14 px-4 md:px-8 gap-2">

      <a href="/" aria-label="Pingflare home" class="shrink-0">
        <img src="/logo.png" alt="Pingflare" class="h-7 object-contain" />
      </a>
      <span class="sm:hidden text-sm font-medium mr-2" style="color: rgb(var(--text))">Pingflare</span>

      <!-- Desktop nav -->
      <nav class="hidden sm:flex items-center gap-0.5">
        {#each nav as item}
          {@const active = isActive(item.href, $page.url.pathname)}
          <a href={item.href} class={active ? 'nav-link-active' : 'nav-link'}>
            <Icon name={item.icon} size={14} />
            <span>{item.label}</span>
          </a>
        {/each}
      </nav>

      <!-- Right actions (always visible) -->
      <div class="ml-auto flex items-center gap-1">
        <span class="text-xs tabular-nums px-1.5" style="color: rgb(var(--text-muted))">{countdown}s</span>
        <button
          type="button"
          class="btn-outline p-2"
          aria-label={$theme === 'dark' ? $t('theme.toLightMode') : $t('theme.toDarkMode')}
          on:click={() => theme.toggle()}>
          <Icon name={$theme === 'dark' ? 'sun' : 'moon'} size={18} />
        </button>
        {#if !authDisabled}
          <button
            type="button"
            class="btn-outline p-2"
            aria-label={$t('layout.signOut')}
            on:click={logout}>
            <Icon name="arrow-right-on-rect" size={18} />
          </button>
        {/if}
        <!-- Hamburger only on mobile -->
        <button
          type="button"
          class="sm:hidden btn-outline p-2"
          aria-label="Menu"
          on:click={() => menuOpen = !menuOpen}>
          <Icon name={menuOpen ? 'x-mark' : 'bars-3'} size={18} />
        </button>
      </div>

    </div>

    <!-- Mobile dropdown menu -->
    {#if menuOpen}
    <div class="sm:hidden" style="border-top: 1px solid var(--border-color)">
      <nav class="flex flex-col py-1">
        {#each nav as item}
          {@const active = isActive(item.href, $page.url.pathname)}
          <a
            href={item.href}
            class={active ? 'nav-link-active' : 'nav-link'}
            style="border-radius: 0; padding: 0.625rem 1rem; justify-content: flex-start"
            on:click={() => menuOpen = false}>
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </a>
        {/each}
      </nav>
    </div>
    {/if}

  </header>

  <main class="flex-1">
    <slot />
  </main>

  <footer style="border-top: 1px solid var(--border-color)">
    <div class="max-w-5xl mx-auto flex items-center justify-between h-9 px-4 md:px-8">
      <span class="text-xs tabular-nums" style="color: rgb(var(--text-muted))">v{APP_VERSION}</span>
      {#if updateAvailable}
        <a
          href="https://github.com/{GITHUB_REPO}/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1.5 text-xs font-medium rounded px-2 py-0.5 transition-opacity hover:opacity-80"
          style="color: #ff6633; border: 1px solid color-mix(in srgb, #ff6633 35%, transparent); background: color-mix(in srgb, #ff6633 10%, transparent)"
        >
          <Icon name="exclamation-triangle" size={11} />
          {$t('footer.updateAvailable')} (v{latestVersion}) - {$t('footer.update')}
        </a>
      {/if}
      <a
        href="https://github.com/{GITHUB_REPO}"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-1 text-xs transition-opacity hover:opacity-80"
        style="color: rgb(var(--text-muted))"
      >
        <Icon name="github" size={14} />
        GitHub
      </a>
    </div>
  </footer>

</div>
