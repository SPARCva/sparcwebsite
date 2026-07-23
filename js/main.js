// SPARC Solutions - Main JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Initialize all components
    initAnnouncementBar();
    initMobileNav();
    initStickyHeader();
    initScrollAnimations();
    initSmoothScroll();
    initDonationForm();
    initContactForm();
});

// Site-wide announcement bar (promotes the annual gala across every page).
// Bump ANNOUNCE_KEY to re-show the bar to visitors who previously dismissed it.
function initAnnouncementBar() {
    var ANNOUNCE_KEY = 'sparcAnnouncementDismissed:gala-2026';
    var LINK = '/gala/';

    // Respect a prior dismissal.
    try {
        if (window.localStorage && localStorage.getItem(ANNOUNCE_KEY) === '1') { return; }
    } catch (e) { /* localStorage unavailable — show the bar anyway */ }

    // Don't stack on the bare, embeddable form pages (they have no site header).
    if (!document.querySelector('.header')) { return; }

    var bar = document.createElement('aside');
    bar.className = 'announcement-bar';
    bar.setAttribute('aria-label', 'Site announcement');
    bar.innerHTML =
        '<div class="announcement-bar__inner">' +
            '<a class="announcement-bar__link" href="' + LINK + '">' +
                '<span class="announcement-bar__title">An Evening to SPARCle</span>' +
                '<span class="announcement-bar__date">Saturday, November 14, 2026</span>' +
                '<span class="announcement-bar__cta">Reserve your seat or become a sponsor &rarr;</span>' +
            '</a>' +
            '<button type="button" class="announcement-bar__close" aria-label="Dismiss announcement">&times;</button>' +
        '</div>';

    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('has-announcement-bar');

    function setHeight() {
        document.body.style.setProperty('--announcement-h', bar.offsetHeight + 'px');
    }
    setHeight();
    window.addEventListener('resize', setHeight);

    bar.querySelector('.announcement-bar__close').addEventListener('click', function () {
        try { if (window.localStorage) { localStorage.setItem(ANNOUNCE_KEY, '1'); } } catch (e) {}
        window.removeEventListener('resize', setHeight);
        bar.remove();
        document.body.classList.remove('has-announcement-bar');
        document.body.style.removeProperty('--announcement-h');
    });
}

// Mobile Navigation Toggle
function initMobileNav() {
    const toggle = document.querySelector('.mobile-toggle');
    const menu = document.querySelector('.nav-menu');

    if (toggle && menu) {
        toggle.addEventListener('click', function() {
            menu.classList.toggle('active');
            toggle.classList.toggle('active');

            // Animate hamburger to X
            const spans = toggle.querySelectorAll('span');
            if (toggle.classList.contains('active')) {
                spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
                spans[1].style.opacity = '0';
                spans[2].style.transform = 'rotate(-45deg) translate(7px, -6px)';
            } else {
                spans[0].style.transform = 'none';
                spans[1].style.opacity = '1';
                spans[2].style.transform = 'none';
            }
        });

        // Close menu when clicking outside
        document.addEventListener('click', function(e) {
            if (!toggle.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('active');
                toggle.classList.remove('active');
                const spans = toggle.querySelectorAll('span');
                spans[0].style.transform = 'none';
                spans[1].style.opacity = '1';
                spans[2].style.transform = 'none';
            }
        });

        // Close menu when clicking a link
        menu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', function() {
                menu.classList.remove('active');
                toggle.classList.remove('active');
            });
        });
    }
}

// Sticky Header with Shadow on Scroll
function initStickyHeader() {
    const header = document.querySelector('.header');

    if (header) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 50) {
                header.classList.add('scrolled');
            } else {
                header.classList.remove('scrolled');
            }
        });
    }
}

// Scroll Animations (Fade In Elements)
function initScrollAnimations() {
    const fadeElements = document.querySelectorAll('.fade-in');

    if (fadeElements.length === 0) return;

    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    fadeElements.forEach(el => observer.observe(el));
}

// Smooth Scroll for Anchor Links
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');

            if (targetId === '#') return;

            const targetElement = document.querySelector(targetId);

            if (targetElement) {
                e.preventDefault();
                const headerOffset = 100;
                const elementPosition = targetElement.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Donation Form - Amount Selection
function initDonationForm() {
    const amountBtns = document.querySelectorAll('.amount-btn');
    const customAmountInput = document.querySelector('#custom-amount');

    if (amountBtns.length === 0) return;

    amountBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all buttons
            amountBtns.forEach(b => b.classList.remove('active'));

            // Add active class to clicked button
            this.classList.add('active');

            // If custom amount input exists, clear it when preset is selected
            if (customAmountInput && !this.classList.contains('custom')) {
                customAmountInput.value = '';
            }
        });
    });

    // Custom amount input handling
    if (customAmountInput) {
        customAmountInput.addEventListener('focus', function() {
            amountBtns.forEach(b => b.classList.remove('active'));
        });
    }
}

// Contact Form Validation and Submission
function initContactForm() {
    const contactForm = document.querySelector('#contact-form');

    if (!contactForm) return;

    contactForm.addEventListener('submit', function(e) {
        e.preventDefault();

        // Basic validation
        const name = contactForm.querySelector('[name="name"]');
        const email = contactForm.querySelector('[name="email"]');
        const message = contactForm.querySelector('[name="message"]');

        let isValid = true;

        // Clear previous errors
        contactForm.querySelectorAll('.error-message').forEach(el => el.remove());
        contactForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));

        // Validate name
        if (!name.value.trim()) {
            showError(name, 'Please enter your name');
            isValid = false;
        }

        // Validate email
        if (!email.value.trim() || !isValidEmail(email.value)) {
            showError(email, 'Please enter a valid email address');
            isValid = false;
        }

        // Validate message
        if (!message.value.trim()) {
            showError(message, 'Please enter your message');
            isValid = false;
        }

        if (isValid) {
            // Show success message (in production, this would submit to a server)
            const successMessage = document.createElement('div');
            successMessage.className = 'success-message';
            successMessage.innerHTML = '<p>Thank you for your message! We will get back to you soon.</p>';
            successMessage.style.cssText = 'background: #2a9d8f; color: white; padding: 15px; border-radius: 4px; margin-bottom: 20px;';

            contactForm.insertBefore(successMessage, contactForm.firstChild);
            contactForm.reset();

            // Remove success message after 5 seconds
            setTimeout(() => {
                successMessage.remove();
            }, 5000);
        }
    });
}

// Helper function to show form errors
function showError(input, message) {
    input.classList.add('error');
    input.style.borderColor = '#e74c3c';

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    errorDiv.style.cssText = 'color: #e74c3c; font-size: 0.85rem; margin-top: 5px;';

    input.parentNode.appendChild(errorDiv);
}

// Email validation helper
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Counter Animation for Stats
function animateCounters() {
    const counters = document.querySelectorAll('.stat-number');

    counters.forEach(counter => {
        const dataTarget = counter.getAttribute('data-target');
        // Skip counters without a valid data-target attribute
        if (!dataTarget) return;

        const target = parseInt(dataTarget);
        if (isNaN(target)) return;

        const duration = 2000; // 2 seconds
        const step = target / (duration / 16); // 60fps
        let current = 0;

        const updateCounter = () => {
            current += step;
            if (current < target) {
                counter.textContent = Math.floor(current).toLocaleString();
                requestAnimationFrame(updateCounter);
            } else {
                counter.textContent = target.toLocaleString();
            }
        };

        updateCounter();
    });
}

// Initialize counter animation when stats section is in view
const statsSection = document.querySelector('.stats-section');
if (statsSection) {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateCounters();
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.5 });

    observer.observe(statsSection);
}

// Video autoplay handling for hero
const heroVideo = document.querySelector('.hero-video');
if (heroVideo) {
    // Attempt to play video (may be blocked by browser autoplay policies)
    heroVideo.play().catch(function(error) {
        console.log('Autoplay prevented:', error);
        // Show play button or fallback image if needed
    });
}

// ========== Mailing List Modal ==========
function openMailingListModal() {
    var modal = document.getElementById('mailingListModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeMailingListModal() {
    var modal = document.getElementById('mailingListModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// Close modal when clicking overlay background
document.addEventListener('DOMContentLoaded', function() {
    var modal = document.getElementById('mailingListModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                closeMailingListModal();
            }
        });
    }

    // Close modal with Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeMailingListModal();
        }
    });
});
