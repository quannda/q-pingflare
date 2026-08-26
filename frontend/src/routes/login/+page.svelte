<script lang="ts">
  import { api } from '$lib/api'
  import { token } from '$lib/stores'
  import { t, locale, localeOptions } from '$lib/i18n'
  import { goto } from '$app/navigation'
  import { onMount } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  let username = ''
  let password = ''
  let error = ''
  let loading = false

  onMount(async () => {
    if (localStorage.getItem('token')) {
      goto('/')
      return
    }
    // Nothing to sign into when the origin delegates auth to a proxy.
    if ((await api.auth.config()).authDisabled) goto('/')
  })

  async function login() {
    loading = true
    error = ''
    try {
      const res = await api.auth.login(username, password)
      token.set(res.token)
      goto('/')
    } catch (e) {
      error = $t('login.invalidCreds')
    } finally {
      loading = false
    }
  }
</script>

<svelte:head><title>{$t('login.signIn')} - Pingflare</title></svelte:head>

<div class="min-h-screen flex items-center justify-center relative overflow-hidden"
  style="background-color: rgb(var(--bg))">

  <HeaderPattern />

  <div class="absolute inset-0 pointer-events-none"
    style="background: radial-gradient(ellipse 80% 50% at 50% -10%, rgb(255 102 51 / 0.08), transparent)"></div>

  <div class="relative w-full max-w-sm px-4">

    <div class="mb-8 text-center">
      <img src="/logo.png" alt="Pingflare" class="h-16 mx-auto mb-3" />
    </div>

    <div class="rounded-lg p-6 space-y-4"
      style="background-color: rgb(var(--card)); border: 1px solid var(--border-color)">

      <form on:submit|preventDefault={login} class="space-y-4">
        <div>
          <label for="username" class="label">{$t('login.username')}</label>
          <input id="username" class="input" bind:value={username}
            autocomplete="username" required placeholder="admin" />
        </div>
        <div>
          <label for="password" class="label">{$t('login.password')}</label>
          <input id="password" class="input" type="password" bind:value={password}
            autocomplete="current-password" required placeholder="••••••••" />
        </div>

        {#if error}
          <div class="flex items-center gap-2 text-sm px-3 py-2"
            style="background: rgb(239 68 68 / .08); color: #ef4444">
            <Icon name="exclamation-triangle" size={14} />
            {error}
          </div>
        {/if}

        <button type="submit" class="btn-primary w-full justify-center mt-1" disabled={loading}>
          {#if loading}
            <Icon name="arrow-path" size={14} cls="animate-spin" />
            {$t('login.signingIn')}
          {:else}
            {$t('login.signIn')}
          {/if}
        </button>
      </form>
    </div>

    <div class="mt-4 flex justify-center">
      <select
        class="input py-1 px-2 text-xs cursor-pointer w-auto"
        value={$locale}
        on:change={(e) => locale.set(e.currentTarget.value)}
        aria-label={$t('login.language')}
      >
        {#each localeOptions as opt}
          <option value={opt.code}>{opt.name}</option>
        {/each}
      </select>
    </div>

  </div>
</div>
