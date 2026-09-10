const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const togglePassword = document.getElementById('togglePassword');
const loginButton = document.getElementById('loginButton');
const loginMessage = document.getElementById('loginMessage');

const getNextPath = () => {
  const raw = new URLSearchParams(location.search).get('next') || '/dashboard/';
  return raw.startsWith('/dashboard') && !raw.startsWith('//') ? raw : '/dashboard/';
};

const showMessage = (message, type = 'error') => {
  loginMessage.textContent = message;
  loginMessage.className = `login-message show ${type}`;
};

const clearMessage = () => {
  loginMessage.textContent = '';
  loginMessage.className = 'login-message';
};

togglePassword?.addEventListener('click', () => {
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  togglePassword.textContent = reveal ? 'HIDE' : 'SHOW';
  togglePassword.setAttribute('aria-label', reveal ? 'Sembunyikan password' : 'Tampilkan password');
});

const checkExistingSession = async () => {
  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (response.ok) location.replace(getNextPath());
  } catch (_) {
    // Worker backend may not be active yet. The form will show a clearer error on submit.
  }
};

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    showMessage('Username dan password wajib diisi.');
    return;
  }

  loginButton.disabled = true;
  loginButton.querySelector('span:first-child').textContent = 'Authenticating…';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (response.ok) {
      showMessage('Login berhasil. Membuka Seller Dashboard…', 'info');
      location.replace(getNextPath());
      return;
    }

    if (data.error === 'setup_required') {
      showMessage('Seller auth belum dikonfigurasi di Cloudflare Secret. Tambahkan SELLER_PASSWORD dan SESSION_SECRET terlebih dahulu.');
    } else if (response.status === 404) {
      showMessage('Backend auth belum aktif pada Worker. Tunggu deployment konfigurasi Worker selesai.');
    } else if (response.status === 429) {
      showMessage('Terlalu banyak percobaan. Coba lagi beberapa saat.');
    } else {
      showMessage('Username atau password tidak sesuai.');
    }
  } catch (_) {
    showMessage('Tidak dapat menghubungi server auth. Coba refresh setelah deployment selesai.');
  } finally {
    loginButton.disabled = false;
    loginButton.querySelector('span:first-child').textContent = 'Enter Seller Dashboard';
  }
});

checkExistingSession();
