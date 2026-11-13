FROM nginx:alpine

# Copy custom nginx configuration template
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Copy the synth as the entry index.html
COPY index.html /usr/share/nginx/html/index.html

# SEO/static assets served alongside the app
COPY robots.txt sitemap.xml og-image.png /usr/share/nginx/html/

# Expose port (Cloud Run sets PORT env variable, Nginx templates will substitute it)
EXPOSE 8080
